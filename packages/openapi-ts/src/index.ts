import path from 'node:path';

import { loadConfig } from 'c12';
import { sync } from 'cross-spawn';

import { generateOutput } from './generate/output';
import { parse, parseExperimental } from './openApi';
import { defaultPluginConfigs } from './plugins';
import type { Client } from './types/client';
import type { ClientConfig, Config, UserConfig } from './types/config';
import { CLIENTS } from './types/config';
import { getConfig, isLegacyClient, setConfig } from './utils/config';
import { getOpenApiSpec } from './utils/getOpenApiSpec';
import { registerHandlebarTemplates } from './utils/handlebars';
import {
  operationFilterFn,
  operationNameFn,
  operationParameterFilterFn,
  operationParameterNameFn,
} from './utils/parse';
import { Performance, PerformanceReport } from './utils/performance';
import { postProcessClient } from './utils/postprocess';

type OutputProcessor = {
  args: (path: string) => ReadonlyArray<string>;
  command: string;
  name: string;
};

/**
 * Map of supported formatters
 */
const formatters: Record<
  Extract<Config['output']['format'], string>,
  OutputProcessor
> = {
  biome: {
    args: (path) => ['format', '--write', path],
    command: 'biome',
    name: 'Biome (Format)',
  },
  prettier: {
    args: (path) => [
      '--ignore-unknown',
      path,
      '--write',
      '--ignore-path',
      './.prettierignore',
    ],
    command: 'prettier',
    name: 'Prettier',
  },
};

/**
 * Map of supported linters
 */
const linters: Record<
  Extract<Config['output']['lint'], string>,
  OutputProcessor
> = {
  biome: {
    args: (path) => ['lint', '--apply', path],
    command: 'biome',
    name: 'Biome (Lint)',
  },
  eslint: {
    args: (path) => [path, '--fix'],
    command: 'eslint',
    name: 'ESLint',
  },
};

const processOutput = () => {
  const config = getConfig();

  if (config.output.format) {
    const module = formatters[config.output.format];
    console.log(`✨ Running ${module.name}`);
    sync(module.command, module.args(config.output.path));
  }

  if (config.output.lint) {
    const module = linters[config.output.lint];
    console.log(`✨ Running ${module.name}`);
    sync(module.command, module.args(config.output.path));
  }
};

const logClientMessage = () => {
  const { client } = getConfig();
  switch (client.name) {
    case 'legacy/angular':
      return console.log('✨ Creating Angular client');
    case '@hey-api/client-axios':
    case 'legacy/axios':
      return console.log('✨ Creating Axios client');
    case '@hey-api/client-fetch':
    case 'legacy/fetch':
      return console.log('✨ Creating Fetch client');
    case 'legacy/node':
      return console.log('✨ Creating Node.js client');
    case 'legacy/xhr':
      return console.log('✨ Creating XHR client');
  }
};

const getClient = (userConfig: ClientConfig): Config['client'] => {
  let client: Config['client'] = {
    bundle: false,
    name: '' as Config['client']['name'],
  };
  if (typeof userConfig.client === 'string') {
    client.name = userConfig.client;
  } else if (userConfig.client) {
    client = {
      ...client,
      ...userConfig.client,
    };
  }
  return client;
};

const getOutput = (userConfig: ClientConfig): Config['output'] => {
  let output: Config['output'] = {
    format: false,
    lint: false,
    path: '',
  };
  if (typeof userConfig.output === 'string') {
    output.path = userConfig.output;
  } else {
    output = {
      ...output,
      ...userConfig.output,
    };
  }
  return output;
};

const getPlugins = (userConfig: ClientConfig): Config['plugins'] => {
  const plugins: Config['plugins'] = (userConfig.plugins ?? []).map((plugin) =>
    typeof plugin === 'string'
      ? defaultPluginConfigs[plugin]
      : {
          ...defaultPluginConfigs[plugin.name],
          ...(plugin as (typeof defaultPluginConfigs)[(typeof plugin)['name']]),
        },
  ) as unknown as Config['plugins'];
  return plugins;
};

const getSchemas = (userConfig: ClientConfig): Config['schemas'] => {
  let schemas: Config['schemas'] = {
    export: true,
    type: 'json',
  };
  if (typeof userConfig.schemas === 'boolean') {
    schemas.export = userConfig.schemas;
  } else {
    schemas = {
      ...schemas,
      ...userConfig.schemas,
    };
  }
  return schemas;
};

const getServices = (userConfig: ClientConfig): Config['services'] => {
  let services: Config['services'] = {
    asClass: false,
    export: true,
    name: '{{name}}Service',
    operationId: true,
    response: 'body',
  };
  if (typeof userConfig.services === 'boolean') {
    services.export = userConfig.services;
  } else if (typeof userConfig.services === 'string') {
    services.include = userConfig.services;
  } else {
    services = {
      ...services,
      ...userConfig.services,
    };
  }
  return services;
};

const getTypes = (
  userConfig: ClientConfig,
  services: Config['services'],
): Config['types'] => {
  let types: Config['types'] = {
    dates: false,
    enums: false,
    export: true,
    name: 'preserve',
    tree: !services.export,
  };
  if (typeof userConfig.types === 'boolean') {
    types.export = userConfig.types;
  } else if (typeof userConfig.types === 'string') {
    types.include = userConfig.types;
  } else {
    types = {
      ...types,
      ...userConfig.types,
    };
  }
  return types;
};

const initConfigs = async (userConfig: UserConfig): Promise<Config[]> => {
  let configurationFile: string | undefined = undefined;
  if (userConfig.configFile) {
    const parts = userConfig.configFile.split('.');
    configurationFile = parts.slice(0, parts.length - 1).join('.');
  }

  const { config: configFromFile } = await loadConfig<UserConfig>({
    configFile: configurationFile,
    jitiOptions: {
      esmResolve: true,
    },
    name: 'openapi-ts',
  });

  const userConfigs: ClientConfig[] = Array.isArray(userConfig)
    ? userConfig
    : Array.isArray(configFromFile)
      ? configFromFile.map((config) => ({
          ...config,
          ...userConfig,
        }))
      : [{ ...(configFromFile ?? {}), ...userConfig }];

  return userConfigs.map((userConfig) => {
    const {
      base,
      configFile = '',
      debug = false,
      dryRun = false,
      exportCore = true,
      experimental_parser = false,
      input,
      name,
      request,
      useOptions = true,
    } = userConfig;

    if (debug) {
      console.warn('userConfig:', userConfig);
    }

    const output = getOutput(userConfig);

    if (!input) {
      throw new Error(
        '🚫 missing input - which OpenAPI specification should we use to generate your client?',
      );
    }

    if (!output.path) {
      throw new Error(
        '🚫 missing output - where should we generate your client?',
      );
    }

    const client = getClient(userConfig);

    if (client.name && !CLIENTS.includes(client.name)) {
      throw new Error('🚫 invalid client - select a valid client value');
    }

    if (!useOptions) {
      console.warn(
        '❗️ Deprecation warning: useOptions set to false. This setting will be removed in future versions. Please migrate useOptions to true https://heyapi.vercel.app/openapi-ts/migrating.html#v0-27-38',
      );
    }

    const plugins = getPlugins(userConfig);
    const schemas = getSchemas(userConfig);
    const services = getServices(userConfig);
    const types = getTypes(userConfig, services);

    output.path = path.resolve(process.cwd(), output.path);

    const config = setConfig({
      base,
      client,
      configFile,
      debug,
      dryRun,
      experimental_parser,
      exportCore: isLegacyClient(client) ? exportCore : false,
      input,
      name,
      output,
      plugins,
      request,
      schemas,
      services,
      types,
      useOptions,
    });

    if (debug) {
      console.warn('config:', config);
    }

    return config;
  });
};

/**
 * Generate the OpenAPI client. This method will read the OpenAPI specification and based on the
 * given language it will generate the client, including the typed models, validation schemas,
 * service layer, etc.
 * @param userConfig {@link UserConfig} passed to the `createClient()` method
 */
export async function createClient(
  userConfig: UserConfig,
): Promise<ReadonlyArray<Client>> {
  Performance.start('createClient');

  Performance.start('config');
  const configs = await initConfigs(userConfig);
  Performance.end('config');

  Performance.start('handlebars');
  const templates = registerHandlebarTemplates();
  Performance.end('handlebars');

  const pCreateClient = (config: Config) => async () => {
    Performance.start('openapi');
    const openApi =
      typeof config.input === 'string'
        ? await getOpenApiSpec(config.input)
        : (config.input as unknown as Awaited<
            ReturnType<typeof getOpenApiSpec>
          >);
    Performance.end('openapi');

    if (config.experimental_parser) {
      Performance.start('experimental_parser');
      parseExperimental({
        spec: openApi,
      });
      Performance.end('experimental_parser');
    } else {
      Performance.start('parser');
      const parsed = parse({
        config: {
          filterFn: {
            operation: operationFilterFn,
            operationParameter: operationParameterFilterFn,
          },
          nameFn: {
            operation: operationNameFn,
            operationParameter: operationParameterNameFn,
          },
        },
        openApi,
      });
      const client = postProcessClient(parsed);
      Performance.end('parser');

      logClientMessage();

      Performance.start('generator');
      await generateOutput(openApi, client, templates);
      Performance.end('generator');

      Performance.start('postprocess');
      if (!config.dryRun) {
        processOutput();

        console.log('✨ Done! Your client is located in:', config.output.path);
      }
      Performance.end('postprocess');

      return client;
    }
  };

  const clients: Array<Client> = [];

  const pClients = configs.map((config) => pCreateClient(config));
  for (const pClient of pClients) {
    const client = await pClient();
    if (client) {
      clients.push(client);
    }
  }

  Performance.end('createClient');

  if (userConfig.debug) {
    const perfReport = new PerformanceReport({
      totalMark: 'createClient',
    });
    perfReport.report({
      marks: [
        'config',
        'openapi',
        'handlebars',
        'parser',
        'generator',
        'postprocess',
      ],
    });
  }

  return clients;
}

/**
 * Type helper for openapi-ts.config.ts, returns {@link UserConfig} object
 */
export const defineConfig = (config: UserConfig): UserConfig => config;

export default {
  createClient,
  defineConfig,
};

export type { OpenApiV3_0_3 } from './openApi/3.0.3';
export type { OpenApiV3_1 } from './openApi/3.1';
export type { UserConfig } from './types/config';
