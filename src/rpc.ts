import { Rpc } from "@opencode/plugin/rpc"

const string = { type: "string" } as const
const result = { type: "object", additionalProperties: true } as const

const sessionInput = {
  type: "object",
  properties: { sessionID: string },
  additionalProperties: false,
} as const

const sessionSourceInput = {
  type: "object",
  properties: { sessionID: string, source: string },
  required: ["sessionID", "source"],
  additionalProperties: false,
} as const

export const K8s = Rpc.define({
  id: "k8s.manager",
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: string, directory: string },
        required: ["sessionID", "directory"],
        additionalProperties: false,
      },
    },
  },
  methods: {
    state: {
      input: {
        type: "object",
        properties: { sessionID: string },
        additionalProperties: false,
      },
      output: result,
    },
    setContext: {
      input: {
        type: "object",
        properties: { sessionID: string, context: string },
        required: ["sessionID", "context"],
        additionalProperties: false,
      },
      output: result,
    },
    enableSource: { input: sessionSourceInput, output: result },
    disableSource: { input: sessionSourceInput, output: result },
    setEnabled: {
      input: {
        type: "object",
        properties: {
          sessionID: string,
          enabled: { type: "array", items: string },
        },
        required: ["sessionID", "enabled"],
        additionalProperties: false,
      },
      output: result,
    },
    syncProfile: {
      input: {
        type: "object",
        properties: { sessionID: string, profile: string },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: result,
    },
    addSource: {
      input: {
        type: "object",
        properties: {
          sessionID: string,
          kind: { type: "string", enum: ["file", "dir", "secret-store", "vault"] },
          path: string,
          entry: string,
          label: string,
        },
        required: ["kind"],
        additionalProperties: false,
      },
      output: result,
    },
    removeSource: {
      input: {
        type: "object",
        properties: { sessionID: string, id: string },
        required: ["id"],
        additionalProperties: false,
      },
      output: result,
    },
    saveProfileLink: {
      input: {
        type: "object",
        properties: { sessionID: string, profile: string },
        required: ["sessionID", "profile"],
        additionalProperties: false,
      },
      output: result,
    },
    clear: { input: sessionInput, output: result },
    refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: result,
    },
    secretStoreEntries: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: result,
    },
    test: { input: sessionInput, output: result },
  },
})

// JSON Schema definitions are portable at runtime, but `Rpc.define` types them
// as codecs. Callers only need the portable shape.
export const K8sRpc = K8s as unknown as Rpc.PortableDefinition
