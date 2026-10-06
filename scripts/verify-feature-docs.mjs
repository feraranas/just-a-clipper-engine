import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_SECTIONS = [
  'Mermaid flowchart',
  'Lifecycle/state diagram',
  'Human approval and external-side-effect boundaries',
  'Failure and retry paths',
  'Invariants',
  'Implementation reconciliation and deviations',
];

export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return {};
  return Object.fromEntries(match[1].split('\n').flatMap((line) => {
    const separator = line.indexOf(':');
    return separator === -1 ? [] : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
  }));
}

export function verifyFeatureDocs(root = process.cwd()) {
  const directory = join(root, 'docs', 'features');
  let files;
  try {
    files = readdirSync(directory).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return { valid: false, errors: ['docs/features: directory is missing'] };
  }

  const errors = [];
  for (const file of files) {
    const relative = `docs/features/${file}`;
    const content = readFileSync(join(directory, file), 'utf8');
    const metadata = parseFrontmatter(content);
    if (!metadata.feature) errors.push(`${relative}: feature is required`);
    if (!['DESIGN', 'IN_PROGRESS', 'COMPLETE'].includes(metadata.status)) {
      errors.push(`${relative}: status must be DESIGN, IN_PROGRESS or COMPLETE`);
    }
    const reviewValues = metadata.status === 'DESIGN' ? ['true', 'false'] : ['true'];
    if (!reviewValues.includes(metadata['design-reviewed'])) {
      errors.push(`${relative}: design-reviewed must be ${reviewValues.join(' or ')}`);
    }
    const expectedReconciliation = metadata.status === 'COMPLETE' ? 'true' : 'false';
    if (metadata['implementation-reconciled'] !== expectedReconciliation) {
      errors.push(`${relative}: implementation-reconciled must be ${expectedReconciliation} for ${metadata.status}`);
    }
    for (const section of REQUIRED_SECTIONS) {
      if (!new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(content)) {
        errors.push(`${relative}: missing required section "${section}"`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = verifyFeatureDocs();
  if (!result.valid) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Verified ${readdirSync(join(process.cwd(), 'docs', 'features')).filter((file) => file.endsWith('.md')).length} feature document(s).`);
  }
}
