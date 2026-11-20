import type { Api, Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { ModelAuthError, type ModelCredential } from '../../ports/models.ts';
import { ModelServiceError, modelServiceError } from '../model-error.ts';
import {
  cloudflareAccountPattern,
  cloudflareGatewayPattern,
  modelProviderInfo,
  modelProviderNames,
  neonGatewayAddress,
  type OpenAIRegion,
  type ModelProvider,
} from '../../shared/models.ts';
import { openAIBaseUrl } from '../openai/api.ts';

const modelId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9@][a-zA-Z0-9_./:@+-]*$/)
  .refine((id) => id.split('/').every((part) => part !== '.' && part !== '..'));
const specialist =
  /(?:^|[-_/.:])(?:image|audio|tts|live|embed(?:ding)?s?|rerank|moderation|safeguard|guard|search|research|computer-use|voxtral)(?:[-_/.:]|$)/i;
const catalogEndpoints = {
  xai: 'https://api.x.ai/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
  deepseek: 'https://api.deepseek.com/models',
  moonshotai: 'https://api.moonshot.ai/v1/models',
  'moonshotai-cn': 'https://api.moonshot.cn/v1/models',
  together: 'https://api.together.xyz/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models',
} as const;

export function openAIModels(region: OpenAIRegion = 'global'): Model<'openai-responses'>[] {
  const rate = region === 'global' ? 1 : 1.1;
  return [
    {
      id: 'gpt-6.2-sol',
      name: 'GPT-6.2 Sol',
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    },
    {
      id: 'gpt-6.2-astra',
      name: 'GPT-6.2 Astra',
      cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
    },
  ].map((model) => ({
    ...model,
    provider: 'openai',
    api: 'openai-responses',
    baseUrl: openAIBaseUrl(region),
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: {
      input: model.cost.input * rate,
      output: model.cost.output * rate,
      cacheRead: model.cost.cacheRead * rate,
      cacheWrite: model.cost.cacheWrite * rate,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: model.cost.input * 2 * rate,
          output: model.cost.output * 1.5 * rate,
          cacheRead: model.cost.cacheRead * 2 * rate,
          cacheWrite: model.cost.cacheWrite * 2 * rate,
        },
      ],
    },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    compat: {
      supportsStrictMode: true,
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoSystemMessages: true,
      supportsExplicitPromptCacheMode: true,
      supportsMidConvoEffort: true,
    },
    inputLimits: {
      maxRequestBytes: 536_870_912,
      images: {
        maxPerRequest: 1500,
        resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
      },
    },
  }));
}

export const nativeAudioModel: Model<'openai-completions'> = {
  id: 'gpt-audio-1.5',
  name: 'GPT Audio 1.5',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStrictMode: false },
};

export const antLingModel: Model<'openai-completions'> = {
  id: 'Ling-3.1-flash',
  name: 'Ling 3.1 Flash',
  provider: 'ant-ling',
  api: 'openai-completions',
  baseUrl: 'https://api.ant-ling.com/v1',
  reasoning: true,
  input: ['text'],
  contextWindow: 262144,
  maxTokens: 32768,
  cost: { input: 0.075, output: 0.225, cacheRead: 0.015, cacheWrite: 0 },
  thinkingLevelMap: {
    off: 'disabled',
    minimal: null,
    low: null,
    medium: 'enabled',
    high: null,
    xhigh: null,
    max: null,
  },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsStrictMode: false,
    maxTokensField: 'max_tokens',
    thinkingFormat: 'deepseek',
  },
};

const neonCatalogUrl = 'https://neon.com/models.json';
const neonEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const neonPrice = {
  input: z.number().nonnegative().finite(),
  output: z.number().nonnegative().finite(),
  cache_read: z.number().nonnegative().finite().optional(),
  cache_write: z.number().nonnegative().finite().optional(),
};
const neonModelSchema = z.object({
  id: modelId,
  name: z.string().min(1).max(200),
  lab: z.string().max(100),
  released: z.boolean().optional(),
  tool_call: z.literal(true),
  open_weights: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(
      z.object({
        type: z.string().max(50),
        values: z.array(z.string().max(50)).max(20).optional(),
      }),
    )
    .max(10)
    .optional(),
  modalities: z.object({
    input: z.array(z.string().max(50)).max(20),
    output: z.array(z.string().max(50)).max(20),
  }),
  limit: z.object({
    context: z.number().int().positive().max(100_000_000),
    output: z.number().int().positive().max(100_000_000),
  }),
  cost: z
    .object({
      ...neonPrice,
      tiers: z
        .array(
          z.object({
            ...neonPrice,
            tier: z.object({ type: z.literal('context'), size: z.number().int().positive() }),
          }),
        )
        .max(10)
        .optional(),
    })
    .optional(),
});

export function neonCredential(credential: ModelCredential) {
  if (
    credential.type !== 'neon' ||
    !credential.key ||
    neonGatewayAddress(credential.url) !== credential.url
  )
    throw new Error('The selected Neon AI Gateway connection is unavailable.');
  return credential;
}

function neonModel(
  url: string,
  model: z.infer<typeof neonModelSchema>,
  claude: readonly Model<Api>[],
): Model<Api> {
  const anthropic = model.lab === 'anthropic';
  const known = anthropic ? claude.find((item) => item.id === model.id) : undefined;
  const responses = model.lab === 'openai' && !model.open_weights;
  const options = model.reasoning_options ?? [];
  const efforts = options.find((option) => option.type === 'effort')?.values ?? [];
  const reasoning =
    model.reasoning === true && (anthropic ? options.length > 0 : efforts.length > 0);
  const rates = (price: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  }) => ({
    input: price.input,
    output: price.output,
    cacheRead: price.cache_read ?? price.input,
    cacheWrite: price.cache_write ?? price.input,
  });
  return {
    id: model.id,
    name: model.name,
    provider: 'neon',
    api: anthropic ? 'anthropic-messages' : responses ? 'openai-responses' : 'openai-completions',
    baseUrl: anthropic ? `${url}/anthropic` : responses ? `${url}/openai/v1` : `${url}/v1`,
    reasoning: known?.reasoning ?? reasoning,
    ...(known
      ? { thinkingLevelMap: known.thinkingLevelMap }
      : reasoning
        ? {
            thinkingLevelMap: {
              off: anthropic
                ? options.some((option) => option.type === 'toggle')
                  ? undefined
                  : null
                : efforts.includes('none')
                  ? 'none'
                  : null,
              ...(efforts.length
                ? Object.fromEntries(
                    neonEfforts.map((level) => [level, efforts.includes(level) ? level : null]),
                  )
                : {}),
            },
          }
        : {}),
    input: model.modalities.input.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: model.limit.context,
    maxTokens: Math.min(model.limit.output, model.limit.context),
    cost: model.cost
      ? {
          ...rates(model.cost),
          ...(model.cost.tiers?.length
            ? {
                tiers: model.cost.tiers.map((tier) => ({
                  inputTokensAbove: tier.tier.size,
                  ...rates(tier),
                })),
              }
            : {}),
        }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: anthropic
      ? {
          forceAdaptiveThinking: known
            ? (known.compat as { forceAdaptiveThinking?: boolean } | undefined)
                ?.forceAdaptiveThinking === true
            : efforts.length > 0,
        }
      : responses
        ? {}
        : {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsLongCacheRetention: false,
            maxTokensField: 'max_tokens',
          },
  } as Model<Api>;
}

export function assistantModelId(id: string) {
  return !specialist.test(id);
}

export function assistantModels(models: readonly Model<Api>[]) {
  return models.filter((model) => model.input.includes('text') && assistantModelId(model.id));
}

export function cloudflareCredential(provider: ModelProvider, credential: ModelCredential) {
  if (
    credential.type !== 'cloudflare' ||
    !credential.key ||
    !cloudflareAccountPattern.test(credential.accountId) ||
    (provider === 'cloudflare-ai-gateway' &&
      (!credential.gatewayId || !cloudflareGatewayPattern.test(credential.gatewayId)))
  )
    throw new Error('The selected Cloudflare connection is unavailable.');
  return credential;
}

export async function nativeCatalog(
  provider: ModelProvider,
  local: Model<Api>[],
  credential: ModelCredential,
  request: typeof fetch,
): Promise<Model<Api>[]> {
  const failed = () =>
    new Error(`${modelProviderNames[provider]} couldn’t load its models. Try again.`);
  const denied = () =>
    new ModelAuthError(
      provider === 'cloudflare-ai-gateway'
        ? 'Cloudflare couldn’t read this gateway. Check its Account ID, Gateway ID and token’s AI Gateway Read permission.'
        : provider === 'neon'
          ? 'Neon AI Gateway didn’t accept this token. Check that the token and base URL come from the same Neon branch and that the token has the ai_gateway:invoke scope.'
          : `${modelProviderNames[provider]} didn’t accept this API key. Check its permissions and try again.`,
    );
  const read = async (url: string | URL, headers: Record<string, string>) => {
    try {
      const response = await request(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const error = await modelServiceError(
          response,
          `${modelProviderNames[provider]} model discovery`,
          Object.values(headers).map((value) => value.replace(/^Bearer /, '')),
        );
        if (
          response.status === 401 ||
          response.status === 403 ||
          (provider === 'google' && response.status === 400) ||
          (provider === 'cloudflare-ai-gateway' && response.status === 404)
        )
          throw new ModelAuthError(`${denied().message} ${error.message}`);
        throw error;
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof ModelAuthError || error instanceof ModelServiceError) throw error;
      throw failed();
    }
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success) throw failed();
    return result.data;
  };
  const list = <T>(value: unknown, schema: z.ZodType<T>) =>
    parse(z.array(z.unknown()).max(10000), value).flatMap((entry) => {
      const result = schema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  const select = (ids: Iterable<string>) => {
    const accepted = new Set(ids);
    return local.filter((model) => accepted.has(model.id));
  };

  if (provider === 'cloudflare-workers-ai' || provider === 'cloudflare-ai-gateway') {
    const value = cloudflareCredential(provider, credential);
    const headers = { Authorization: `Bearer ${value.key}` };
    const base = `https://api.cloudflare.com/client/v4/accounts/${value.accountId}`;
    if (provider === 'cloudflare-ai-gateway') {
      const gateway = parse(
        z.object({ success: z.literal(true), result: z.object({ id: z.string() }) }),
        await read(`${base}/ai-gateway/gateways/${value.gatewayId}`, headers),
      );
      if (gateway.result.id !== value.gatewayId) throw failed();
      return local;
    }
    const ids = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const data = parse(
        z.object({
          success: z.literal(true),
          result: z.array(z.unknown()).max(1000),
          result_info: z
            .object({ total_pages: z.number().int().nonnegative().max(100).optional() })
            .optional(),
        }),
        await read(`${base}/ai/models/search?per_page=100&page=${page}`, headers),
      );
      for (const model of list(data.result, z.object({ name: modelId }))) ids.add(model.name);
      if (
        data.result_info?.total_pages !== undefined
          ? page >= data.result_info.total_pages
          : data.result.length < 100
      )
        return select(ids);
    }
    throw failed();
  }

  if (provider === 'neon') {
    const { url, key } = neonCredential(credential);
    const gateway = parse(
      z.object({ data: z.array(z.unknown()).max(10000) }),
      await read(`${url}/v1/models`, { Authorization: `Bearer ${key}` }),
    );
    const enabled = new Set(
      list(gateway.data, z.object({ id: modelId, enabled: z.boolean().optional() }))
        .filter((model) => model.enabled !== false)
        .map((model) => model.id),
    );
    const catalog = parse(
      z.object({ neon: z.object({ models: z.record(z.string(), z.unknown()) }) }),
      await read(neonCatalogUrl, {}),
    );
    return assistantModels(
      list(Object.values(catalog.neon.models), neonModelSchema)
        .filter(
          (model) =>
            model.released !== false &&
            enabled.has(model.id) &&
            !model.id.startsWith('gemini-') &&
            model.modalities.input.includes('text') &&
            model.modalities.output.includes('text'),
        )
        .map((model) => neonModel(url, model, local)),
    );
  }

  if (credential.type !== 'api_key' || !credential.key)
    throw new Error('The selected model connection is unavailable.');
  const headers = { Authorization: `Bearer ${credential.key}` };
  if (modelProviderInfo[provider].catalog === 'bundled') return local;

  if (provider === 'google') {
    const tokens = new Set<string>();
    const ids = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (token) url.searchParams.set('pageToken', token);
      const data = parse(
        z.object({
          models: z.array(z.unknown()).max(1000).default([]),
          nextPageToken: z.string().max(10000).optional(),
        }),
        await read(url, { 'x-goog-api-key': credential.key }),
      );
      for (const model of list(
        data.models,
        z.object({ name: z.string().max(210), supportedGenerationMethods: z.array(z.string()) }),
      )) {
        if (
          model.name.startsWith('models/') &&
          model.supportedGenerationMethods.includes('generateContent')
        )
          ids.add(model.name.slice('models/'.length));
      }
      token = data.nextPageToken;
      if (!token) return select(ids);
      if (tokens.has(token)) throw failed();
      tokens.add(token);
    }
    throw failed();
  }

  if (provider === 'mistral') {
    const data = parse(
      z.object({ data: z.array(z.unknown()).max(10000) }),
      await read('https://api.mistral.ai/v1/models', headers),
    );
    const models = list(
      data.data,
      z.object({
        id: modelId,
        archived: z.boolean().optional(),
        capabilities: z.object({
          completion_chat: z.boolean(),
          function_calling: z.boolean(),
          vision: z.boolean().optional(),
        }),
      }),
    ).filter(
      (model) =>
        !model.archived &&
        model.capabilities.completion_chat &&
        model.capabilities.function_calling,
    );
    const vision = new Map(models.map((model) => [model.id, model.capabilities.vision]));
    return select(models.map((model) => model.id)).map((model) => {
      const supportsImages = vision.get(model.id);
      if (supportsImages === undefined) return model;
      return {
        ...model,
        input: supportsImages
          ? [...new Set([...model.input, 'image' as const])]
          : model.input.filter((input) => input !== 'image'),
      };
    });
  }

  if (provider === 'radius') {
    const data = parse(
      z.object({
        baseUrl: z.literal('https://radius.pi.dev/v1'),
        models: z.array(z.unknown()).max(1000),
      }),
      await read('https://radius.pi.dev/v1/config', headers),
    );
    const models = list(
      data.models,
      z.object({
        id: modelId,
        name: z.string().min(1).max(200),
        reasoning: z.boolean(),
        input: z
          .array(z.enum(['text', 'image']))
          .min(1)
          .max(2),
        cost: z.object({
          input: z.number().nonnegative().finite(),
          output: z.number().nonnegative().finite(),
          cacheRead: z.number().nonnegative().finite(),
          cacheWrite: z.number().nonnegative().finite(),
        }),
        contextWindow: z.number().int().positive().max(100000000),
        maxTokens: z.number().int().positive().max(100000000),
        thinkingLevelMap: z
          .partialRecord(
            z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
            z.string().max(50).nullable(),
          )
          .optional(),
      }),
    ).map((model) => ({
      ...local.find((known) => known.id === model.id),
      ...model,
      api: 'pi-messages' as const,
      provider,
      baseUrl: data.baseUrl,
    }));
    return assistantModels([...new Map(models.map((model) => [model.id, model])).values()]);
  }

  if (Object.hasOwn(catalogEndpoints, provider)) {
    const data = await read(catalogEndpoints[provider as keyof typeof catalogEndpoints], headers);
    const models =
      provider === 'together' ? data : parse(z.object({ data: z.array(z.unknown()) }), data).data;
    return select(
      list(models, z.object({ id: modelId, active: z.boolean().optional() }))
        .filter((model) => model.active !== false)
        .map((model) => model.id),
    );
  }
  throw new Error('This model provider is unavailable.');
}
