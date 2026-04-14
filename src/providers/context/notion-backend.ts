import type { ContextNotionProviderConfig } from "../../config/types.js";

import { UnimplementedContextBackend } from "./unimplemented-context-backend.js";

export class NotionContextBackend extends UnimplementedContextBackend<ContextNotionProviderConfig> {}
