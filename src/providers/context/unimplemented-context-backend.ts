import type { ContextProviderDefinition } from "../../config/types.js";
import type {
  ArtifactRecord,
  RunLedgerRecord,
} from "../../domain-model.js";
import {
  ContextBackend,
  type AppendEvidenceInput,
  type ContextBundle,
  type CreateRunLedgerEntryInput,
  type EnsureArtifactInput,
  type FinalizeRunLedgerEntryInput,
  type LoadContextBundleInput,
  type WritePhaseArtifactInput,
} from "../../core/context-backend.js";

export abstract class UnimplementedContextBackend<
  TConfig extends ContextProviderDefinition,
> extends ContextBackend<TConfig> {
  constructor(config: TConfig) {
    super(config);
  }

  async validateConfig(): Promise<void> {}

  async ensureArtifact(_input: EnsureArtifactInput): Promise<ArtifactRecord> {
    return this.unsupportedOperation("ensureArtifact");
  }

  async getArtifactByWorkItemId(
    _workItemId: string,
  ): Promise<ArtifactRecord | null> {
    return this.unsupportedOperation("getArtifactByWorkItemId");
  }

  async loadContextBundle(
    _input: LoadContextBundleInput,
  ): Promise<ContextBundle> {
    return this.unsupportedOperation("loadContextBundle");
  }

  async writePhaseArtifact(
    _input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord> {
    return this.unsupportedOperation("writePhaseArtifact");
  }

  async createRunLedgerEntry(
    _input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    return this.unsupportedOperation("createRunLedgerEntry");
  }

  async getRunLedgerEntry(_runId: string): Promise<RunLedgerRecord | null> {
    return this.unsupportedOperation("getRunLedgerEntry");
  }

  async finalizeRunLedgerEntry(
    _input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    return this.unsupportedOperation("finalizeRunLedgerEntry");
  }

  async appendEvidence(_input: AppendEvidenceInput): Promise<void> {
    return this.unsupportedOperation("appendEvidence");
  }
}
