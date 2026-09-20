export const safePathPart = (value, label) => {
  const pathPart = String(value);
  if (
    pathPart === "." ||
    pathPart === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(pathPart)
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return pathPart;
};
