const { AzureChatOpenAI, ChatOpenAI } = require('@langchain/openai');
const { assertRagConfig, getRagConfig } = require('./config');

let llm = null;

function getRagLlm() {
  if (llm) return llm;

  const config = getRagConfig();
  assertRagConfig(config);

  const temperature = Number.isFinite(config.llmTemperature) ? config.llmTemperature : 0.2;

  if (config.llmProvider === 'grok') {
    llm = new ChatOpenAI({
      apiKey: config.xaiApiKey,
      model: config.grokModel,
      configuration: { baseURL: config.xaiBaseUrl },
      temperature,
      maxRetries: 2,
    });
  } else {
    llm = new AzureChatOpenAI({
      azureOpenAIApiKey: config.azureApiKey,
      azureOpenAIEndpoint: config.azureEndpoint,
      azureOpenAIApiDeploymentName: config.azureDeployment,
      azureOpenAIApiVersion: config.azureApiVersion,
      temperature,
      maxRetries: 2,
    });
  }

  return llm;
}

module.exports = {
  getRagLlm,
};
