import type { PlanningLocalFilesProviderConfig } from "../../config/types.js";

import { UnimplementedPlanningBackend } from "./unimplemented-planning-backend.js";

export class LocalFilesPlanningBackend extends UnimplementedPlanningBackend<PlanningLocalFilesProviderConfig> {}
