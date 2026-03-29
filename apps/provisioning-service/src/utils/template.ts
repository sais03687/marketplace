/**
 * Replace {{VAR}} placeholders in a string with values from a map.
 */
export function expandTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return vars[key] ?? match;
  });
}
