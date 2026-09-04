export function profileToolsVisibility({
  editing,
  handle,
}: {
  editing: boolean;
  handle: string;
}) {
  return editing && Boolean(handle.trim());
}
