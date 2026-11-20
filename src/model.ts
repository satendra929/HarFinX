// The single place where a model provider is chosen.
// To add a provider: add one case in createModelFor().
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { Config } from "./config.ts";

// Hard constraint: Claude is used ONLY through a Console API key, never a Pro/Max subscription.
function assertNoSubscriptionAuth(cfg: Config): void {
  if (process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN is set. Subscription tokens are not allowed. " +
        "Unset them and use a Console API key in ANTHROPIC_API_KEY.",
    );
  }
  if (cfg.anthropicApiKey.includes("sk-ant-oat")) {
    throw new Error("ANTHROPIC_API_KEY looks like a subscription (OAuth) token. Use a Console API key instead.");
  }
  if (!cfg.anthropicApiKey) {
    throw new Error("PROVIDER=anthropic but ANTHROPIC_API_KEY is missing. Add a Console API key to .env.");
  }
}

export function createModelFor(cfg: Config): { models: ReturnType<typeof createModels>; model: Model<any> } {
  // No attribution headers.
  const models = createModels({ identity: { attribution: null } });

  switch (cfg.provider) {
    case "ollama": {
      const ollamaModel: Model<"openai-completions"> = {
        id: cfg.ollamaModel,
        name: `${cfg.ollamaModel} (Ollama)`,
        api: "openai-completions",
        provider: "ollama",
        baseUrl: cfg.ollamaBaseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: cfg.ollamaContext, // read from OLLAMA_CONTEXT_LENGTH, the variable the Ollama server must also have
        maxTokens: 4096,
        // Do NOT add `maxTokensField: "max_tokens"` here without also fixing the numbers above. Ollama ignores the
        // `max_completion_tokens` Pi sends by default, which is why replies are not cut today: Pi reserves a fixed
        // 4,096-token margin, so in a small window (8k) it would ask for almost no output once the prompt grows
        // past about half the window. A looping reply is stopped by src/runaway.ts instead.
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        // Pi merges these into every request body; Ollama's OpenAI-compatible API reads `temperature`. Unset: nothing is
        // sent and Ollama uses the model's own default.
        ...(cfg.ollamaTemperature !== undefined ? { samplingParams: { temperature: cfg.ollamaTemperature } } : {}),
      };
      models.setProvider(
        createProvider({
          id: "ollama",
          name: "Ollama",
          baseUrl: cfg.ollamaBaseUrl,
          // Ollama needs no key, but Pi's OpenAI client refuses an empty one: send a placeholder.
          auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: { apiKey: "ollama" } }) } },
          models: [ollamaModel],
          api: openAICompletionsApi(),
        }),
      );
      return { models, model: getOrThrow(models, "ollama", cfg.ollamaModel) };
    }
    case "anthropic": {
      assertNoSubscriptionAuth(cfg);
      // Own API-key-only provider. Do NOT use Pi's anthropicProvider(): it supports subscription OAuth.
      models.setProvider(
        createProvider({
          id: "anthropic",
          auth: { apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
          models: Object.values(ANTHROPIC_MODELS),
          api: anthropicMessagesApi(),
        }),
      );
      return { models, model: getOrThrow(models, "anthropic", cfg.anthropicModel) };
    }
  }
}

function getOrThrow(models: ReturnType<typeof createModels>, provider: string, id: string): Model<any> {
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`Model "${id}" not found for provider "${provider}".`);
  return model;
}
