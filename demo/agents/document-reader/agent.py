"""Document Reader — reads text out of scanned or photographed documents, with Tesseract OCR.

Attach images (PNG, JPG, TIFF) of receipts, invoices, forms or letters and say
what you need: "What's the total on this receipt?", "Pull the invoice number,
date and amount due". It replies with the answer and attaches the full text it
read from each image.
"""
import asyncio
import io
import re

from llm_extract import extract

IMAGE_TYPES = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp")

SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "fields": {"type": "array", "items": {"type": "object", "properties": {
            "field": {"type": "string"}, "value": {"type": "string"}, "source_file": {"type": "string"}}}},
        "not_found": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer", "fields", "not_found"],
}


def _ocr(raw: bytes) -> str:
    import pytesseract
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img).convert("L")
    if max(img.size) < 1500:   # small photos read better enlarged
        scale = 1500 / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    # One block of rows, not auto-detected columns: on a tilted photo the default
    # layout pass dropped a receipt's whole right-hand price column.
    return pytesseract.image_to_string(img, config="--psm 6")


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def _read_from(field, value, source_file, texts: dict) -> bool:
    """Whether `value` is really in the OCR text: of its file if it names one, of any otherwise."""
    needle = _squash(value)
    if not needle:
        return False
    # The label handed back as its own value ("total: TOTAL") is in the text too.
    if set(re.findall(r"\w+", needle)) <= set(re.findall(r"\w+", _squash(field))):
        return False
    pool = [texts[source_file]] if source_file in texts else list(texts.values())
    # Standing on its own, not a piece of a longer word or figure: "3" is not
    # read from "38.50", nor "1,971" from "1,971.48".
    whole = re.compile(r"(?<![0-9a-z])(?<![0-9][.,])" + re.escape(needle) + r"(?![0-9a-z])(?![.,][0-9])")
    return any(whole.search(_squash(t)) for t in pool)


async def run_agent(content: str, context: dict, file_resolver_fn=None, attach_fn=None) -> dict:
    found = [a for a in context.get("attachments") or [] if a.get("handle")]
    images = [f for f in found if f["name"].lower().endswith(IMAGE_TYPES)
              or str(f.get("content_type", "")).startswith("image/")]
    skipped = [f["name"] for f in found if f not in images]
    if not images:
        return {"action": "reply_email", "text": "Attach the document as an image (PNG, JPG or TIFF — a phone "
                "photo is fine) and tell me what you need from it." + (
                    f" I can't read {', '.join(skipped)} — PDFs and other formats need to be sent as images."
                    if skipped else "")}

    texts, unreadable = {}, []
    for f in images[:10]:
        raw = file_resolver_fn(f["handle"]) if file_resolver_fn else None
        if not raw:
            unreadable.append(f["name"])
            continue
        try:
            texts[f["name"]] = (await asyncio.to_thread(_ocr, raw)).strip()
        except Exception as exc:
            unreadable.append(f"{f['name']} ({type(exc).__name__})")

    if not any(texts.values()):
        return {"action": "reply_email", "text": "I couldn't read any text from the attached image(s)"
                + (f" ({', '.join(unreadable)})" if unreadable else "")
                + ". A sharper, straight-on photo with good light usually fixes that."}

    corpus = "\n\n".join(f"=== {name} ===\n{text}" for name, text in texts.items())
    req = await extract(
        "You are given the text read by OCR from one or more documents, and the sender's request. "
        "Answer the request from the OCR text only. Put each value you were asked for in 'fields' with "
        "the file it came from, copying numbers exactly as they appear. List anything requested that the "
        "text does not contain in 'not_found' — never guess. 'answer' is a one- or two-sentence reply.",
        f"REQUEST (the email):\n{content[:3000]}\n\nOCR TEXT:\n{corpus}", SCHEMA, SCHEMA["required"])

    # A value counts only if it is in the text that was read. The model has
    # answered "TOTAL" for a total the OCR missed, and returned a figure it had
    # garbled; both went out as if read from the page.
    fields, not_found = [], list((req or {}).get("not_found") or [])
    for f in (req or {}).get("fields") or []:
        if _read_from(f.get("field"), f.get("value"), f.get("source_file"), texts):
            fields.append(f)
        else:
            not_found.append(str(f.get("field"))
                             + (f" ({f.get('source_file')})" if len(texts) > 1 and f.get("source_file") else ""))
    rejected = len(fields) < len((req or {}).get("fields") or [])
    not_found = list(dict.fromkeys(not_found))

    # The model's sentence may repeat a value that was just rejected.
    lines = [(not rejected and (req or {}).get("answer")) or "Here is what I read from the document(s)."]
    for f in fields:
        lines.append(f"  {f.get('field')}: {f.get('value')}"
                     + (f"  ({f.get('source_file')})" if len(texts) > 1 and f.get("source_file") else ""))
    if not_found:
        lines.append("Not in the document: " + ", ".join(not_found))
    if unreadable:
        lines.append("Could not read: " + ", ".join(unreadable))
    if skipped:
        lines.append("Skipped (not images): " + ", ".join(skipped))
    lines.append("OCR can misread characters — check figures that matter against the original.")

    deliverables = []
    if attach_fn:
        for name, text in texts.items():
            out = re.sub(r"\.[^.]+$", "", name) + "_text.txt"
            if attach_fn(out, text):
                deliverables.append(out)
        if deliverables:
            lines.append("Attached: the full text read from each image.")
    return {"action": "reply_email", "text": "\n".join(lines), "deliverables": deliverables}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
