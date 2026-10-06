import { parseFrontmatter } from './verify-feature-docs.mjs';

const documentationPath = (path) =>
  path === 'README.md' || path === 'AGENTS.md' ||
  (path.startsWith('docs/') && path.endsWith('.md'));

export function checkFeatureReadiness({ body = '', files, readDocument }) {
  if (files.every(file => documentationPath(file.filename) &&
    (!file.previous_filename || documentationPath(file.previous_filename)))) return [];

  body = (body ?? '').replace(/\r\n/g, '\n');
  const declarations = [...body.matchAll(/^Feature-docs:[ \t]*(.*)$/gm)];
  if (declarations.length !== 1) return ['Implementation PRs require exactly one Feature-docs: declaration.'];
  const declaration = declarations[0][1].trim();
  if (declaration === 'none') {
    return /^Feature-docs-reason:[ \t]*\S[^\r\n]*$/m.test(body)
      ? [] : ['Feature-docs: none requires a Feature-docs-reason: line for reviewer assessment.'];
  }
  const paths = declaration.split(',').map(path => path.trim());
  if (paths.some(path => !/^docs\/features\/[a-zA-Z0-9_-]+\.md$/.test(path))) {
    return ['Feature-docs must list docs/features/<name>.md paths separated by commas.'];
  }
  const errors = [];
  for (const path of new Set(paths)) {
    let metadata;
    try { metadata = parseFrontmatter(readDocument(path)); }
    catch { errors.push(`${path}: declared feature document is missing or unreadable`); continue; }
    if (metadata.status !== 'COMPLETE' || metadata['design-reviewed'] !== 'true' ||
        metadata['implementation-reconciled'] !== 'true') {
      errors.push(`${path}: implementation PR requires COMPLETE, reviewed and reconciled metadata`);
    }
  }
  return errors;
}
