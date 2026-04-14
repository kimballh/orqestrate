import type { ContextProviderDefinition } from "../config/types.js";
import type {
  ArtifactRecord,
  ProviderError,
  RunLedgerRecord,
  RunStatus,
  WorkItemRecord,
  WorkPhase,
} from "../domain-model.js";

import { ProviderBackend } from "./provider-backend.js";

export type ContextReference = {
  kind: string;
  title: string;
  url?: string | null;
};

export type ContextBundle = {
  artifact: ArtifactRecord | null;
  contextText: string;
  references: ContextReference[];
};

export type EnsureArtifactInput = {
  workItem: WorkItemRecord;
};

export type LoadContextBundleInput = {
  workItem: WorkItemRecord;
  artifact?: ArtifactRecord | null;
  phase: WorkPhase;
};

export type WritePhaseArtifactInput = {
  workItem: WorkItemRecord;
  artifact: ArtifactRecord;
  phase: WorkPhase;
  content: string;
  summary?: string | null;
};

export type CreateRunLedgerEntryInput = {
  runId: string;
  workItem: WorkItemRecord;
  phase: WorkPhase;
  status: RunStatus;
};

export type FinalizeRunLedgerEntryInput = {
  runId: string;
  status: RunStatus;
  summary?: string | null;
  error?: ProviderError | null;
};

export type AppendEvidenceInput = {
  runId: string;
  workItemId: string;
  section: string;
  content: string;
};

export abstract class ContextBackend<
  TConfig extends ContextProviderDefinition = ContextProviderDefinition,
> extends ProviderBackend<TConfig> {
  abstract ensureArtifact(input: EnsureArtifactInput): Promise<ArtifactRecord>;

  abstract getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<ArtifactRecord | null>;

  abstract loadContextBundle(
    input: LoadContextBundleInput,
  ): Promise<ContextBundle>;

  abstract writePhaseArtifact(
    input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord>;

  abstract createRunLedgerEntry(
    input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord>;

  abstract finalizeRunLedgerEntry(
    input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord>;

  abstract appendEvidence(input: AppendEvidenceInput): Promise<void>;
}
