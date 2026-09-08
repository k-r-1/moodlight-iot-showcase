import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./dynamodb.ts";
import { MoodlightIngestService, type IngestResult } from "./ingest.ts";

type IngestHandler = (event: unknown) => Promise<IngestResult>;
let runtimeHandler: IngestHandler | undefined;

export function createIngestLambdaHandler(service: Pick<MoodlightIngestService, "ingest">): IngestHandler {
  return (event) => service.ingest(event);
}

export async function handler(event: unknown): Promise<IngestResult> {
  runtimeHandler ??= createRuntimeHandler();
  return runtimeHandler(event);
}

function createRuntimeHandler(): IngestHandler {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const repository = new DynamoRepository(client, {
    tenant: requiredEnv("TABLE_TENANT"),
    membership: requiredEnv("TABLE_MEMBERSHIP"),
    pool: requiredEnv("TABLE_POOL"),
    device: requiredEnv("TABLE_DEVICE"),
    deviceClaim: requiredEnv("TABLE_DEVICE_CLAIM"),
  });
  return createIngestLambdaHandler(new MoodlightIngestService(repository));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
