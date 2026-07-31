export async function sendWithOneTopicRetry<T>(options: {
  topicId: number;
  send: (topicId: number) => Promise<T>;
  isUnavailable: (error: unknown) => boolean;
  recover: (staleTopicId: number) => Promise<number>;
  onRecovered?: (topicId: number) => void;
}): Promise<T> {
  try {
    return await options.send(options.topicId);
  } catch (error) {
    if (!options.isUnavailable(error)) throw error;
    const recoveredTopicId = await options.recover(options.topicId);
    options.onRecovered?.(recoveredTopicId);
    return options.send(recoveredTopicId);
  }
}
