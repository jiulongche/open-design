import { describe, expect, it } from 'vitest';

import {
  DESIGN_SYSTEM_COMPONENTS_SCHEMA_VERSION,
  DESIGN_SYSTEM_COMPONENT_SCHEMA_VERSION,
  DESIGN_SYSTEM_INTENT_MAP_SCHEMA_VERSION,
  DesignSystemComponentDefinitionSchema,
  DesignSystemRuntimePathsSchema,
  validateDesignSystemRuntimeReferences,
  type DesignSystemComponentsIndex,
  type DesignSystemIntentMap,
} from '../../src/design-systems/runtime-schema.js';

const button = DesignSystemComponentDefinitionSchema.parse({
  schemaVersion: DESIGN_SYSTEM_COMPONENT_SCHEMA_VERSION,
  id: 'Button',
  name: 'Button',
  selectors: ['.button'],
  variants: {
    primary: { selectors: ['.button--primary'] },
  },
  properties: {
    label: { type: 'string', required: true },
  },
  states: {
    focus: { selectors: ['.button:focus-visible'], required: true },
  },
  implementation: '<button class="button">{{label}}</button>',
});

const componentsIndex: DesignSystemComponentsIndex = {
  schemaVersion: DESIGN_SYSTEM_COMPONENTS_SCHEMA_VERSION,
  components: [{ id: 'Button', path: 'components/Button/component.json' }],
};

describe('design-system runtime schema', () => {
  it('accepts a complete set of safe manifest paths', () => {
    expect(DesignSystemRuntimePathsSchema.parse({
      components: 'manifests/components.json',
      intents: 'manifests/intent-map.json',
      lint: 'rules/lint.json',
      fallback: 'rules/fallback.json',
    })).toEqual({
      components: 'manifests/components.json',
      intents: 'manifests/intent-map.json',
      lint: 'rules/lint.json',
      fallback: 'rules/fallback.json',
    });
  });

  it('rejects traversal, duplicate paths, and partial runtime declarations', () => {
    const unsafeResult = DesignSystemRuntimePathsSchema.safeParse({
      components: '../components.json',
      intents: 'rules/shared.json',
      lint: 'rules/shared.json',
      fallback: 'rules/fallback.json',
    });

    expect(unsafeResult.success).toBe(false);
    if (unsafeResult.success) return;
    expect(unsafeResult.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('safe relative path'),
      expect.stringContaining('duplicate runtime path'),
    ]));

    const partialResult = DesignSystemRuntimePathsSchema.safeParse({
      components: 'manifests/components.json',
      intents: 'manifests/intent-map.json',
      lint: 'rules/lint.json',
    });
    expect(partialResult.success).toBe(false);
    if (!partialResult.success) {
      expect(partialResult.error.issues.map((issue) => issue.message)).toContain('Required');
    }
  });

  it('validates component, variant, property, and state references across files', () => {
    const validIntentMap: DesignSystemIntentMap = {
      schemaVersion: DESIGN_SYSTEM_INTENT_MAP_SCHEMA_VERSION,
      mappings: [{
        intent: 'account.settings.save',
        component: 'Button',
        variant: 'primary',
        properties: { label: 'Save' },
        states: ['focus'],
      }],
    };
    expect(validateDesignSystemRuntimeReferences({
      componentsIndex,
      components: [{ path: 'components/Button/component.json', definition: button }],
      intentMap: validIntentMap,
    })).toEqual([]);

    const invalidIntentMap: DesignSystemIntentMap = {
      ...validIntentMap,
      mappings: [{
        ...validIntentMap.mappings[0]!,
        variant: 'danger',
        properties: { icon: 'trash' },
        states: ['loading'],
      }],
    };
    expect(validateDesignSystemRuntimeReferences({
      componentsIndex,
      components: [{ path: 'components/Button/component.json', definition: button }],
      intentMap: invalidIntentMap,
    })).toEqual([
      'intent mapping account.settings.save at index 0 references unknown variant danger on Button',
      'intent mapping account.settings.save at index 0 references unknown property icon on Button',
      'intent mapping account.settings.save at index 0 references unknown state loading on Button',
    ]);
  });
});
