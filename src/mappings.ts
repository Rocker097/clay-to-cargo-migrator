// The translation table: what a Clay column does -> the Cargo action that
// does the same job.
//
// Rules this table follows, taken from Cargo's own clay-to-cargo recipe
// (getcargohq/cargo-skills, cargo-gtm/recipes/clay-to-cargo.md):
//   - Match on what a column DOES, not its label. Clay renames columns after
//     vendors, so matching uses the action key and its inputs.
//   - A provider Cargo does not carry is swapped for the action Cargo's recipe
//     names for that job, and the swap is reported, never silent.
//   - Anything that cannot be mapped with confidence is reported as unmapped.
//
// Every entry records where its Cargo signature was confirmed, so a reviewer
// can check it. Credit costs are from cargo-gtm/references/credits-cost-table.md.

export interface ParamSpec {
  /** Input field name on the Cargo action. */
  cargoField: string;
  /** Clay inputsBinding names (normalized) that fill this field. */
  clayAliases: string[];
  required: boolean;
}

export interface ActionMapping {
  id: string;
  /** Plain description of the job, used in the report. */
  job: string;
  /** Decides whether a Clay action column is this job. */
  match: (actionKey: string) => boolean;
  connector: { varName: string; slug: string; integration: string };
  action: string;
  params: ParamSpec[];
  /** Field read when a formula or run condition references the column bare. */
  primaryField?: string;
  /** Verified provider response path for a normalized tool output. */
  outputPaths?: Record<string, string[]>;
  /** Output fields confirmed in Cargo source, with their types. */
  knownOutputs: Record<string, "string" | "number">;
  /** Clay output field name -> Cargo output field name. */
  fieldSynonyms: Record<string, string>;
  credits: number;
  /** Where the input signature was confirmed. */
  provenance: string;
}

const has = (key: string, ...words: string[]) => words.every((w) => key.includes(w));
const any = (key: string, ...words: string[]) => words.some((w) => key.includes(w));

const FIRST = ["first_name", "firstname", "first"];
const LAST = ["last_name", "lastname", "last"];
const DOMAIN = ["company_identifier", "domain", "company_domain", "companydomain", "website", "company_website", "url"];

export const ACTION_MAPPINGS: ActionMapping[] = [
  {
    id: "company-from-domain",
    job: "Enrich company from domain",
    match: (k) => any(k, "company", "firmographic", "organization", "org-") && any(k, "enrich", "lookup", "find", "data") && !any(k, "email", "person", "people", "employee-search"),
    connector: { varName: "linkedin", slug: "linkedin", integration: "linkedin" },
    action: "enrichCompanyFromDomain",
    params: [{ cargoField: "domain", clayAliases: DOMAIN, required: true }],
    primaryField: "company_name",
    knownOutputs: {
      company_id: "string",
      company_name: "string",
      domain: "string",
      website: "string",
      linkedin_url: "string",
      employee_count: "number",
      description: "string",
      hq_country: "string",
    },
    fieldSynonyms: {
      name: "company_name",
      company: "company_name",
      employees: "employee_count",
      headcount: "employee_count",
      size: "employee_count",
      country: "hq_country",
      linkedin: "linkedin_url",
    },
    credits: 0.5,
    provenance: "gtm-skills: inbound-qualification/infra/tools/inbound-form.ts, crm-enrichment/infra/tools/account-enrichment.ts",
  },
  {
    id: "person-from-linkedin",
    job: "Enrich person from LinkedIn URL",
    match: (k) => any(k, "person", "profile", "people") && any(k, "linkedin", "enrich") && !any(k, "email"),
    connector: { varName: "linkedin", slug: "linkedin", integration: "linkedin" },
    action: "enrichProfile",
    params: [{ cargoField: "linkedinUrl", clayAliases: ["linkedin_url", "linkedinurl", "linkedin", "profile_url", "url"], required: true }],
    primaryField: "linkedin_url",
    knownOutputs: { profile_id: "string", job_title: "string", linkedin_url: "string" },
    fieldSynonyms: { title: "job_title", headline: "job_title", id: "profile_id" },
    credits: 0.25,
    provenance: "gtm-skills: crm-enrichment/infra/tools/contact-linkedin-enrichment.ts",
  },
  {
    id: "find-email-prospeo",
    job: "Find work email from name + domain (Prospeo)",
    match: (k) => has(k, "prospeo") && any(k, "email"),
    connector: { varName: "prospeo", slug: "prospeo", integration: "prospeo" },
    action: "findEmail",
    params: [
      { cargoField: "firstName", clayAliases: FIRST, required: true },
      { cargoField: "lastName", clayAliases: LAST, required: true },
      { cargoField: "companyDomain", clayAliases: DOMAIN, required: true },
    ],
    primaryField: "email",
    knownOutputs: { email: "string" },
    outputPaths: { email: ["person", "email", "email"] },
    fieldSynonyms: { work_email: "email" },
    credits: 0.5,
    provenance: "gtm-skills: clay-to-cargo/SKILL.md (CLI example; note it takes companyDomain)",
  },
  {
    // Cargo's recipe: "Find work email, name + domain -> FullEnrich.findEmail".
    // Any other email-finder provider (Hunter, Findymail, Dropcontact...) is
    // swapped to this and the swap is reported.
    id: "find-email",
    job: "Find work email from name + domain",
    match: (k) => any(k, "email") && any(k, "find", "finder", "lookup", "search", "enrich", "waterfall") && !any(k, "verif", "valid", "send"),
    connector: { varName: "fullEnrich", slug: "full_enrich", integration: "FullEnrich" },
    action: "findEmail",
    params: [
      { cargoField: "firstName", clayAliases: FIRST, required: true },
      { cargoField: "lastName", clayAliases: LAST, required: true },
      { cargoField: "domainName", clayAliases: DOMAIN, required: true },
    ],
    primaryField: "email",
    knownOutputs: { email: "string" },
    outputPaths: { email: ["most_probable_email"] },
    fieldSynonyms: { work_email: "email" },
    credits: 1,
    provenance: "gtm-skills: clay-to-cargo/SKILL.md (CLI example; note it takes domainName, not companyDomain)",
  },
  {
    id: "verify-email",
    job: "Verify / validate email",
    match: (k) => any(k, "email") && any(k, "verif", "valid", "bounce", "check"),
    connector: { varName: "waterfall", slug: "waterfall", integration: "waterfall" },
    action: "verifyEmail",
    params: [{ cargoField: "email", clayAliases: ["email", "work_email", "email_address"], required: true }],
    knownOutputs: {},
    fieldSynonyms: {},
    credits: 0.1,
    provenance: "gtm-skills: clay-to-cargo/SKILL.md (CLI example)",
  },
];

/** Clay AI / Claygent columns. These become a Cargo agent plus a tool. */
export const isAiAction = (k: string) =>
  /(^|[^a-z])(use-ai|ai-|claygent|chat-gpt|chatgpt|openai|gpt|anthropic|claude|llm)/.test(k) || k === "ai";

/** Writes to a CRM. A sync step, not an enrichment: not generated. */
export const isCrmWrite = (k: string) =>
  any(k, "hubspot", "salesforce", "attio", "pipedrive", "close") && any(k, "create", "update", "upsert", "push", "sync", "write", "add");

/**
 * Jobs Cargo's recipe knows an equivalent for, whose input signature this
 * tool has not confirmed in Cargo source. Reported with the suggestion,
 * never generated.
 */
export const KNOWN_UNVERIFIED: { match: (k: string) => boolean; job: string; suggestion: string }[] = [
  {
    match: (k) => any(k, "builtwith", "techstack", "tech-stack", "technolog"),
    job: "Tech stack / technographics",
    suggestion: "`builtwith.getDomainSummary` (free), then `enrichDomain` on the residue (Cargo recipe)",
  },
  {
    match: (k) => any(k, "http", "api-request", "webhook-call"),
    job: "HTTP / API column",
    suggestion: "Cargo's generic HTTP patterns (cargo-orchestration skill) with the customer's own key",
  },
  {
    match: (k) => any(k, "lookup-table", "lookup-row", "table-lookup"),
    job: "Lookup to another Clay table",
    suggestion: "A relationship between two Cargo models (cargo-storage skill)",
  },
  {
    match: (k) => any(k, "phone", "mobile"),
    job: "Find mobile phone",
    suggestion: "`aiArk.findMobilePhone` (0.5 credits, Cargo recipe)",
  },
  {
    match: (k) => any(k, "funding", "crunchbase"),
    job: "Funding and acquisitions",
    suggestion: "`enrichCrm.getFunding` (1 credit, Cargo recipe)",
  },
];

export function normalizeBindingName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function findMapping(actionKey: string): ActionMapping | undefined {
  const k = actionKey.toLowerCase();
  const mapping = ACTION_MAPPINGS.find((m) => m.match(k));
  // Mixrank company `url` is the LinkedIn company URL in the observed
  // Clay starter export. Keep this alias scoped to that action: other
  // providers may use url for the company website.
  if (mapping?.id === "company-from-domain" && k === "enrich-company-with-mixrank-v2") {
    return { ...mapping, fieldSynonyms: { ...mapping.fieldSynonyms, url: "linkedin_url" } };
  }
  return mapping;
}

/** The Cargo provider a Clay action key names, for reporting swaps. */
export function clayProviderOf(actionKey: string): string {
  return actionKey.split(/[-_:/.]/)[0] || actionKey;
}
