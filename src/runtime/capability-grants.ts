type CapabilityGrantCarrier = {
  grantedCapabilities: readonly string[];
};

export function hasGrantedCapability(
  input: CapabilityGrantCarrier,
  capability: string,
): boolean {
  return input.grantedCapabilities.includes(capability);
}

export function listMissingGrantedCapabilities(
  input: CapabilityGrantCarrier,
  capabilities: readonly string[],
): string[] {
  return capabilities.filter(
    (capability) => !hasGrantedCapability(input, capability),
  );
}
