import { describe, test, expect } from 'bun:test';
import { buildUserPrompt } from '../../src/services/ai-generator.ts';
import type { GeneratorContext } from '../../src/services/ai-generator.ts';

describe('buildUserPrompt', () => {
  const baseContext: GeneratorContext = {
    itemTitle: 'Login times out too quickly',
    itemType: 'Bug',
    itemDescription: 'Users report that the login page times out after 5 seconds.',
    itemFields: {
      'System.State': 'New',
      'System.AreaPath': 'MyProject\\Auth',
    },
  };

  test('includes work item title', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Title:** Login times out too quickly');
  });

  test('includes work item type', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Type:** Bug');
  });

  test('includes description when present', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Description:** Users report that the login page times out after 5 seconds.');
  });

  test('omits description when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, itemDescription: '' });
    expect(prompt).not.toContain('**Description:**');
  });

  test('includes fields section', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('## Fields');
    expect(prompt).toContain('- **System.State:** New');
    expect(prompt).toContain('- **System.AreaPath:** MyProject\\Auth');
  });

  test('omits fields section when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, itemFields: {} });
    expect(prompt).not.toContain('## Fields');
  });

  test('includes all sections in order', () => {
    const prompt = buildUserPrompt(baseContext);
    const wiSection = prompt.indexOf('## Work Item');
    const fieldsSection = prompt.indexOf('## Fields');
    expect(wiSection).toBeLessThan(fieldsSection);
  });
});
