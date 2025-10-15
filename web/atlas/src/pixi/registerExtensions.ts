let registered = false;

export function registerPixiExtensions(): void {
  if (registered) {
    return;
  }
  registered = true;
}
