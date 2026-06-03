const DEFAULT_AZURE_API_VERSION = '2024-10-21';
const DEFAULT_LLM_TEMPERATURE = 0.2;
const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';

// Grok models that are NOT compatible with /v1/chat/completions and therefore
// cannot be used through LangChain's ChatOpenAI. They require xAI's Responses API.
const GROK_CHAT_INCOMPATIBLE_MODELS = new Set([
  'grok-4.20-multi-agent',
  'grok-4.20-multi-agent-latest',
  'grok-4.20-multi-agent-0309',
  'grok-4.20-multi-agent-beta-latest',
  'grok-4.20-multi-agent-beta-0309',
  'grok-4.20-multi-agent-experimental-beta-latest',
  'grok-4.20-multi-agent-experimental-beta-0304',
]);

function parseLlmProvider() {
  const raw = String(process.env.RAG_LLM_PROVIDER || 'azure').trim().toLowerCase();
  if (!raw || raw === 'azure') return 'azure';
  if (raw === 'grok') return 'grok';
  return null;
}

function getRagConfig() {
  const llmProvider = parseLlmProvider();
  const xaiApiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  const grokModel = process.env.GROK_MODEL || process.env.XAI_MODEL;

  return {
    llmProvider,
    azureApiKey: process.env.AZURE_API_KEY,
    azureEndpoint: process.env.AZURE_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION,
    llmTemperature: Number(process.env.RAG_LLM_TEMPERATURE || DEFAULT_LLM_TEMPERATURE),
    xaiApiKey,
    grokModel,
    xaiBaseUrl: process.env.XAI_BASE_URL || DEFAULT_XAI_BASE_URL,
  };
}

function assertRagConfig(config) {
  if (config.llmProvider === null) {
    throw new Error(
      `RAG_LLM_PROVIDER must be "azure" or "grok", got "${process.env.RAG_LLM_PROVIDER}"`,
    );
  }

  if (config.llmProvider === 'azure') {
    if (!config.azureApiKey) {
      throw new Error('AZURE_API_KEY is required for Azure OpenAI chat orchestration');
    }
    if (!config.azureEndpoint) {
      throw new Error('AZURE_ENDPOINT is required for Azure OpenAI chat orchestration');
    }
    if (!config.azureDeployment) {
      throw new Error('AZURE_OPENAI_DEPLOYMENT is required for Azure OpenAI chat orchestration');
    }
    return;
  }

  if (!config.xaiApiKey) {
    throw new Error(
      'XAI_API_KEY or GROK_API_KEY is required for Grok (xAI) chat orchestration',
    );
  }
  if (!config.grokModel) {
    throw new Error('GROK_MODEL or XAI_MODEL is required for Grok (xAI) chat orchestration');
  }
  if (GROK_CHAT_INCOMPATIBLE_MODELS.has(String(config.grokModel).trim().toLowerCase())) {
    throw new Error(
      `GROK_MODEL="${config.grokModel}" is not supported on /v1/chat/completions ` +
        '(it requires xAI\'s Responses API). Use a chat-compatible slug such as ' +
        '"grok-4.3", "grok-4.20-0309-non-reasoning", or "grok-4.20-0309-reasoning".',
    );
  }
}

module.exports = {
  DEFAULT_AZURE_API_VERSION,
  DEFAULT_XAI_BASE_URL,
  GROK_CHAT_INCOMPATIBLE_MODELS,
  getRagConfig,
  assertRagConfig,
};
