import type { ContextLocalFilesProviderConfig } from "../../config/types.js";

import { UnimplementedContextBackend } from "./unimplemented-context-backend.js";

export class LocalFilesContextBackend extends UnimplementedContextBackend<ContextLocalFilesProviderConfig> {}
