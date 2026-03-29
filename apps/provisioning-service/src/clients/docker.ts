import Dockerode from "dockerode";
import { config } from "../config.js";

const docker = new Dockerode();

export interface ContainerEnv {
  DEPLOYMENT_ID: string;
  AGENT_ID: string;
  ANTHROPIC_API_KEY: string;
  AGENTMAIL_API_KEY: string;
  AGENT_EMAIL: string;
  AGENT_NAME: string;
  COMPANY_NAME: string;
  COMPANY_DOMAIN: string;
  MARKETPLACE_APPROVAL_WEBHOOK: string;
  APPROVAL_WEBHOOK_TOKEN: string;
  MODEL: string;
}

function envToArray(env: ContainerEnv): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export async function createAndStartContainer(
  name: string,
  env: ContainerEnv,
): Promise<{ containerId: string; containerName: string }> {
  const container = await docker.createContainer({
    Image: config.openclawImage,
    name,
    Env: envToArray(env),
    ExposedPorts: { "4000/tcp": {} },
    HostConfig: {
      PortBindings: {
        "4000/tcp": [{ HostPort: "0" }], // random available port
      },
      RestartPolicy: { Name: "unless-stopped" },
    },
  });

  await container.start();

  const info = await container.inspect();
  return {
    containerId: info.Id,
    containerName: info.Name.replace(/^\//, ""),
  };
}

export async function getContainerPort(containerName: string): Promise<number> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  const portBindings = info.NetworkSettings.Ports["4000/tcp"];
  if (!portBindings || portBindings.length === 0) {
    throw new Error(`No port binding found for container ${containerName}`);
  }
  return parseInt(portBindings[0].HostPort, 10);
}

export async function stopContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  try {
    await container.stop({ t: 10 });
  } catch (err: any) {
    if (err.statusCode !== 304) throw err; // 304 = already stopped
  }
  await container.remove({ force: true });
}

export async function inspectContainer(
  containerName: string,
): Promise<{ running: boolean; status: string }> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  return {
    running: info.State.Running,
    status: info.State.Status,
  };
}
