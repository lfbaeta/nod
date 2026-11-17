type Manifest = {
  name: string;
  version: string;
  description: string;
  author?: { name?: string };
  extensions: {
    'io.n8n.nod': {
      displayName: string;
      icon?: string;
      categories?: string[];
      prompts: string[];
      requirements: string[];
      limitations: string[];
      connection: { authentication: string[]; endpoint?: unknown };
    };
  };
};
const manifests = import.meta.glob<Manifest>('../../../src/apps/*/plugin.json', {
  eager: true,
  import: 'default',
});
const contracts = import.meta.glob<{ source: string }>(
  '../../../src/apps/*/io.n8n.nod/contract.json',
  { eager: true, import: 'default' },
);
const icons = import.meta.glob<string>('../../../src/apps/*/io.n8n.nod/**/*.{svg,png,webp}', {
  eager: true,
  query: '?url&inline',
  import: 'default',
});

export const apps = Object.entries(manifests)
  .map(([path, manifest]) => {
    const directory = path.slice(0, -'plugin.json'.length);
    const details = manifest.extensions['io.n8n.nod'];
    const contract = contracts[`${directory}io.n8n.nod/contract.json`];
    return {
      slug: manifest.name as string,
      name: details.displayName as string,
      description: manifest.description as string,
      version: manifest.version as string,
      author: manifest.author?.name as string | undefined,
      categories: (details.categories ?? []) as string[],
      prompts: details.prompts as string[],
      requirements: details.requirements as string[],
      limitations: details.limitations as string[],
      authentication: details.connection.authentication as string[],
      instance: Boolean(details.connection.endpoint),
      source: contract.source as string,
      icon: details.icon ? icons[directory + details.icon.replace(/^\.\//, '')] : undefined,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
