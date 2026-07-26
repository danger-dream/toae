export function invokeMenuCallback(
  payload: unknown,
  callback?: (payload?: unknown) => void
): void {
  if (payload !== undefined) callback?.(payload)
}
