import type {
  LoadedConfig,
  NamedPromptAsset,
  PromptOverlayGroup,
  PromptPackConfig,
  ProfileConfig,
  ResolvedPromptBehavior,
} from "./types.js";

type PromptSelectionConfig = Pick<LoadedConfig, "activeProfile" | "promptPacks">;

type ProfilePromptSelection = {
  organizationOverlayNames: string[];
  projectOverlayNames: string[];
  defaultExperimentName?: string;
};

export type PromptSelectionOverrides = {
  promptPackName?: string;
  experiment?: string | null;
};

export type ResolvedPromptSelection = {
  promptPackName: string;
  promptPack: PromptPackConfig;
  overlays: Record<PromptOverlayGroup, NamedPromptAsset[]>;
  experiment: NamedPromptAsset | null;
};

export function resolveProfilePromptBehavior(
  profile: Pick<ProfileConfig, "name">,
  promptPackName: string,
  promptPack: PromptPackConfig,
  selection: ProfilePromptSelection,
): ResolvedPromptBehavior {
  const organizationOverlays = resolveNamedPromptAssets(
    promptPack,
    "organization",
    selection.organizationOverlayNames,
  );
  const projectOverlays = resolveNamedPromptAssets(
    promptPack,
    "project",
    selection.projectOverlayNames,
  );
  const defaultExperiment =
    selection.defaultExperimentName === undefined
      ? undefined
      : resolveNamedExperiment(
          promptPack,
          selection.defaultExperimentName,
          `profiles.${profile.name}.prompt.default_experiment`,
        );

  return {
    promptPackName,
    promptPack,
    organizationOverlayNames: [...selection.organizationOverlayNames],
    projectOverlayNames: [...selection.projectOverlayNames],
    organizationOverlays,
    projectOverlays,
    defaultExperimentName: defaultExperiment?.name,
    defaultExperimentAssetPath: defaultExperiment?.assetPath,
  };
}

export function resolvePromptSelection(
  config: PromptSelectionConfig,
  overrides: PromptSelectionOverrides = {},
): ResolvedPromptSelection {
  const promptPackName =
    overrides.promptPackName ?? config.activeProfile.promptBehavior.promptPackName;
  const promptPack =
    config.promptPacks[promptPackName] ??
    (promptPackName === config.activeProfile.promptBehavior.promptPackName
      ? config.activeProfile.promptBehavior.promptPack
      : undefined);

  if (promptPack === undefined) {
    throw new Error(`Prompt pack '${promptPackName}' is not defined in the loaded config.`);
  }

  const overlays = {
    organization: resolveNamedPromptAssets(
      promptPack,
      "organization",
      config.activeProfile.promptBehavior.organizationOverlayNames,
    ),
    project: resolveNamedPromptAssets(
      promptPack,
      "project",
      config.activeProfile.promptBehavior.projectOverlayNames,
    ),
  } satisfies Record<PromptOverlayGroup, NamedPromptAsset[]>;

  const experimentName =
    overrides.experiment === undefined
      ? (config.activeProfile.promptBehavior.defaultExperimentName ?? null)
      : overrides.experiment;

  return {
    promptPackName,
    promptPack,
    overlays,
    experiment:
      experimentName === null
        ? null
        : resolveNamedExperiment(
            promptPack,
            experimentName,
            overrides.experiment === undefined
              ? `profiles.${config.activeProfile.name}.prompt.default_experiment`
              : "experiment",
          ),
  };
}

function resolveNamedPromptAssets(
  promptPack: PromptPackConfig,
  group: PromptOverlayGroup,
  names: string[],
): NamedPromptAsset[] {
  return names.map((name) => {
    const assetPath = promptPack.overlays[group][name];

    if (assetPath !== undefined) {
      return { name, assetPath };
    }

    const alternateGroup = group === "organization" ? "project" : "organization";
    const alternatePath = promptPack.overlays[alternateGroup][name];

    throw new Error(
      alternatePath === undefined
        ? `Unknown ${group} overlay '${name}' requested.`
        : `Overlay '${name}' is configured as ${withIndefiniteArticle(alternateGroup)} overlay, not ${withIndefiniteArticle(group)} overlay.`,
    );
  });
}

function resolveNamedExperiment(
  promptPack: PromptPackConfig,
  name: string,
  fieldPath: string,
): NamedPromptAsset {
  const assetPath = promptPack.experiments[name];

  if (assetPath === undefined) {
    throw new Error(
      fieldPath === "experiment"
        ? `Unknown prompt experiment '${name}' requested.`
        : `Unknown default prompt experiment '${name}' configured.`,
    );
  }

  return { name, assetPath };
}

function withIndefiniteArticle(value: string): string {
  return /^[aeiou]/i.test(value) ? `an ${value}` : `a ${value}`;
}
