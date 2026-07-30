import type { ModelCapability, ModelConfig } from "@p2i/contracts";

export const modelHasCapability = (model: ModelConfig | undefined, capability: ModelCapability) =>
  Boolean(model && (model.capabilities?.includes(capability) || (!model.capabilities?.length && capability === "text")));
