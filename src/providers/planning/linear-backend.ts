import type { PlanningLinearProviderConfig } from "../../config/types.js";

import { UnimplementedPlanningBackend } from "./unimplemented-planning-backend.js";

export class LinearPlanningBackend extends UnimplementedPlanningBackend<PlanningLinearProviderConfig> {}
