/** Fail closed before an offline workflow can reach any provider-backed operation. */
export function assertResolvedFakeProvider(config, context = 'Offline automation') {
  if (!config || config.provider !== 'fake') {
    const resolved = config?.provider ?? 'unknown';
    const source = config?.source ?? 'unknown';
    throw new Error(
      `${context} refused to run: final resolved provider is ${resolved} (${source}), not fake.`,
    );
  }
  return config;
}

export async function assertFakeHttpProvider(base, context) {
  let response;
  try {
    response = await fetch(`${base}/api/config`);
  } catch (error) {
    throw new Error(`${context} could not verify the final resolved provider.`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(
      `${context} could not verify the final resolved provider (${response.status}).`,
    );
  }
  return assertResolvedFakeProvider(await response.json(), context);
}
