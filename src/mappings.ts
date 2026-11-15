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
  /** Advice from Cargo's clay-to-cargo recipe, added to the report. */
  recipeNote?: string;
  /** Where the input signature was confirmed. */
  provenance: string;
  /** Fixed arguments the Cargo action requires that Clay has no input for. */
  constants?: Record<string, unknown>;
  /**
   * Clay settings with no Cargo field. They are dropped and listed for
   * review instead of blocking the column.
   */
  droppedSettings?: string[];
}

const has = (key: string, ...words: string[]) => words.every((w) => key.includes(w));
const any = (key: string, ...words: string[]) => words.some((w) => key.includes(w));

const FIRST = ["first_name", "firstname", "first"];
const LAST = ["last_name", "lastname", "last"];
const FULL = ["name", "full_name", "fullname"];

// Clay's person enrichments return `experience[]` with company, title and
// url (the company's LinkedIn URL). linkedin.enrichProfile returns
// `experiences[]` with company, title and company_linkedin_url (workspace
// schema). Only these three fields have a counterpart; the first five
// positions are exposed as flat tool outputs (experience_0_company...).
const EXPERIENCE_FIELDS: Record<string, string> = { company: "company", title: "title", url: "company_linkedin_url" };
const EXPERIENCE_SLOTS = [0, 1, 2, 3, 4];
const EXPERIENCE_OUTPUTS = Object.fromEntries(EXPERIENCE_SLOTS.flatMap(i => Object.keys(EXPERIENCE_FIELDS).map(f => [`experience_${i}_${f}`, "string" as const])));
const EXPERIENCE_PATHS = Object.fromEntries(EXPERIENCE_SLOTS.flatMap(i => Object.entries(EXPERIENCE_FIELDS).map(([f, cargo]) => [`experience_${i}_${f}`, ["experiences", String(i), cargo]])));
const EXPERIENCE_SYNONYMS = Object.fromEntries(EXPERIENCE_SLOTS.flatMap(i => Object.keys(EXPERIENCE_FIELDS).map(f => [`experience.${i}.${f}`, `experience_${i}_${f}`])));
const DOMAIN = ["company_identifier", "domain", "company_domain", "companydomain", "website", "company_website", "url"];

export const ACTION_MAPPINGS: ActionMapping[] = [
  {
    // Clay's name -> domain lookups (get-domain-from-company-name,
    // google-company-to-domain). Pipecorn's account match takes a company
    // name and returns a typed domain; reported as a provider swap.
    id: "domain-from-company-name",
    job: "Find a company's domain from its name",
    match: (k) => has(k, "domain") && (has(k, "company-name") || has(k, "company-to-domain")),
    connector: { varName: "pipecorn", slug: "pipecorn", integration: "pipecorn" },
    action: "enrichAccount",
    params: [{ cargoField: "name", clayAliases: ["companyname", "company_name", "company", "name", "query"], required: true }],
    droppedSettings: ["exclude", "language", "country"],
    primaryField: "domain",
    knownOutputs: { domain: "string", website: "string", company_name: "string", linkedin_url: "string" },
    fieldSynonyms: { url: "website", name: "company_name" },
    credits: 0.5,
    recipeNote: "Name matching differs from Clay's Google-based lookup: ambiguous names (\"Mercury\", \"Notion\") can resolve to a different company. Spot-check domains in parity.",
    provenance: "Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15); connector connected in the workspace",
  },
  {
    id: "company-from-domain",
    job: "Enrich company from domain",
    match: (k) => any(k, "company", "firmographic", "organization", "org-") && any(k, "enrich", "lookup", "find", "data") && !any(k, "email", "person", "people", "employee-search", "apollo"),
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
    // person_identifier: Mixrank's v2 input. Only used when it reads a
    // LinkedIn URL (checked in planAction).
    params: [{ cargoField: "linkedinUrl", clayAliases: ["linkedin_url", "linkedinurl", "linkedin", "profile_url", "url", "person_identifier"], required: true }],
    primaryField: "linkedin_url",
    knownOutputs: {
      profile_id: "string", job_title: "string", linkedin_url: "string", full_name: "string", first_name: "string",
      last_name: "string", headline: "string", company: "string", company_domain: "string", company_linkedin_url: "string",
      ...EXPERIENCE_OUTPUTS,
    },
    outputPaths: EXPERIENCE_PATHS,
    fieldSynonyms: { title: "job_title", id: "profile_id", name: "full_name", url: "linkedin_url", ...EXPERIENCE_SYNONYMS },
    credits: 0.25,
    recipeNote:
      "Cargo's clay-to-cargo recipe prefers `aiArk.enrichPerson` (0.1 credits, also returns a verified email, bills 0 on a miss) for rows that already carry a LinkedIn URL. Not generated here because its input signature is not confirmed in Cargo source; worth switching once verified, and running email finders only on the misses.",
    provenance: "gtm-skills: crm-enrichment/infra/tools/contact-linkedin-enrichment.ts; outputs re-checked against the Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
  },
  {
    id: "find-email-prospeo",
    job: "Find work email from name + domain (Prospeo)",
    match: (k) => has(k, "prospeo") && any(k, "email"),
    connector: { varName: "prospeo", slug: "prospeo", integration: "prospeo" },
    action: "findEmail",
    // Workspace schema: only companyDomain is required; a name comes either
    // as first + last or as fullName, which is what Clay's v2 action sends.
    params: [
      { cargoField: "firstName", clayAliases: FIRST, required: false },
      { cargoField: "lastName", clayAliases: LAST, required: false },
      { cargoField: "fullName", clayAliases: FULL, required: false },
      { cargoField: "companyDomain", clayAliases: DOMAIN, required: true },
    ],
    primaryField: "email",
    knownOutputs: { email: "string" },
    outputPaths: { email: ["person", "email", "email"] },
    fieldSynonyms: { work_email: "email" },
    credits: 0.5,
    provenance: "gtm-skills: clay-to-cargo/SKILL.md; inputs and output path re-checked against the Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
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
    primaryField: "email_status",
    knownOutputs: { email: "string", email_status: "string" },
    fieldSynonyms: { status: "email_status" },
    credits: 0.1,
    recipeNote: "Clay's validation status values and Waterfall's `email_status` values are different vocabularies; compare them in parity before relying on downstream conditions.",
    provenance: "gtm-skills: clay-to-cargo/SKILL.md; outputs from the Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
  },
  {
    // Clay's v2 email finders send a full name plus a domain. FindyMail is
    // the workspace action that takes exactly that; FullEnrich and
    // LeadMagic need first and last name, which the migrator will not
    // invent by splitting strings.
    id: "find-email-full-name",
    job: "Find work email from full name + domain",
    match: (k) => any(k, "email") && any(k, "find", "finder", "lookup", "search", "enrich") && !any(k, "verif", "valid", "send"),
    connector: { varName: "findyMail", slug: "findy_mail", integration: "findyMail" },
    action: "findEmail",
    params: [
      { cargoField: "name", clayAliases: FULL, required: true },
      { cargoField: "domain", clayAliases: DOMAIN, required: true },
    ],
    primaryField: "email",
    knownOutputs: { email: "string", name: "string", domain: "string", linkedin_url: "string", job_title: "string" },
    fieldSynonyms: { work_email: "email" },
    credits: 0.5,
    provenance: "Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
  },
  {
    id: "company-from-linkedin",
    job: "Enrich company from LinkedIn company URL",
    // Chosen by input, not keywords: see planAction (company_identifier
    // bound to a LinkedIn URL). Never matched by action key alone.
    match: () => false,
    connector: { varName: "linkedin", slug: "linkedin", integration: "linkedin" },
    action: "enrichCompany",
    params: [{ cargoField: "linkedinUrl", clayAliases: ["company_identifier", "linkedin_url", "linkedinurl", "company_linkedin_url"], required: true }],
    primaryField: "company_name",
    knownOutputs: { company_id: "string", company_name: "string", domain: "string", website: "string", linkedin_url: "string", employee_count: "number", description: "string", hq_country: "string" },
    fieldSynonyms: { name: "company_name", company: "company_name", employees: "employee_count", headcount: "employee_count", size: "employee_count", country: "hq_country", linkedin: "linkedin_url" },
    credits: 0.25,
    provenance: "Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
  },
  {
    id: "apollo-enrich-organization",
    job: "Enrich company from domain (Apollo)",
    match: (k) => has(k, "apollo") && any(k, "company", "organization") && any(k, "enrich"),
    connector: { varName: "apolloio", slug: "apolloio", integration: "apolloio" },
    action: "enrichOrganization",
    params: [{ cargoField: "domain", clayAliases: DOMAIN, required: true }],
    primaryField: "name",
    knownOutputs: {
      name: "string", website_url: "string", linkedin_url: "string", primary_domain: "string", industry: "string",
      country: "string", founded_year: "number", estimated_num_employees: "number", total_funding: "number",
      latest_funding_stage: "string", latest_funding_round_date: "string",
    },
    // Clay's Apollo output nests everything under `organization`, the
    // same as the Cargo action's response.
    outputPaths: Object.fromEntries(["name", "website_url", "linkedin_url", "primary_domain", "industry", "country", "founded_year", "estimated_num_employees", "total_funding", "latest_funding_stage", "latest_funding_round_date"].map(f => [f, ["organization", f]])),
    fieldSynonyms: Object.fromEntries(["name", "website_url", "linkedin_url", "primary_domain", "industry", "country", "founded_year", "estimated_num_employees", "total_funding", "latest_funding_stage", "latest_funding_round_date"].map(f => [`organization.${f}`, f])),
    credits: 1,
    provenance: "Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
  },
  {
    id: "scrape-website",
    job: "Scrape a web page to text",
    match: (k) => any(k, "scrape") && !any(k, "linkedin", "facebook", "instagram", "tiktok", "twitter", "youtube", "list"),
    connector: { varName: "firecrawl", slug: "firecrawl", integration: "firecrawl" },
    action: "scrape",
    params: [{ cargoField: "url", clayAliases: ["url", "website", "page_url"], required: true }],
    constants: { includeFullPage: false, formats: ["markdown"] },
    droppedSettings: ["waitfor", "keepnontext", "outputfields", "customregex", "enablejavascriptrendering", "autoparse", "htmloutputfields_outputfields", "js_render", "premium_proxy", "proxy_country"],
    primaryField: "markdown",
    knownOutputs: { markdown: "string" },
    fieldSynonyms: { bodyText: "markdown", body_text: "markdown", text: "markdown" },
    credits: 0.05,
    recipeNote: "Clay's `bodyText` is plain page text; Firecrawl returns the main content as markdown. Close enough for AI prompts, not byte-identical.",
    provenance: "Cargo workspace connector schema (cargo-ai connection integration list, exported 2026-11-15)",
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
export interface KnownJob {
  /** Action key (lowercased) and normalized input binding names. */
  match: (k: string, inputs: string[]) => boolean;
  job: string;
  suggestion: string;
  /** Checked before the mapping table, because keywords alone misclassify it. */
  first?: boolean;
}

const hasInput = (inputs: string[], ...names: string[]) => inputs.some((i) => names.includes(i));
const LINKEDIN_INPUTS = ["linkedin_url", "linkedinurl", "linkedin", "profile_url", "linkedin_profile", "linkedin_profile_url"];
const EMAIL_INPUTS = ["email", "work_email", "email_address", "personal_email"];
const NAME_INPUTS = ["first_name", "firstname", "first", "full_name", "name", "last_name", "lastname", "last"];

export const KNOWN_UNVERIFIED: KnownJob[] = [
  {
    // e.g. apollo-enrich-person with only an email: this is a lookup by
    // email, not LinkedIn profile enrichment.
    first: true,
    match: (k, inputs) =>
      any(k, "person", "people", "contact", "reverse") && any(k, "enrich", "lookup", "reverse", "find") &&
      hasInput(inputs, ...EMAIL_INPUTS) && !hasInput(inputs, ...LINKEDIN_INPUTS) && !hasInput(inputs, ...NAME_INPUTS),
    job: "Person lookup from email (Email -> LinkedIn reverse lookup)",
    suggestion: "`FullEnrich.reverseEmailLookup` (1 credit, Cargo recipe)",
  },
  {
    // e.g. find-linkedin-profile-url with name + company: finds the URL,
    // it does not enrich a profile you already have.
    first: true,
    match: (k, inputs) =>
      any(k, "linkedin") && any(k, "find", "search", "url") && !hasInput(inputs, ...LINKEDIN_INPUTS),
    job: "Find a person's LinkedIn profile from name + company",
    suggestion: "`waterfall.enrichContact` (2 credits, Cargo recipe: enrich person from name + company)",
  },
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

export function findKnownJob(actionKey: string, inputs: string[], first: boolean): KnownJob | undefined {
  const k = actionKey.toLowerCase();
  return KNOWN_UNVERIFIED.find((j) => Boolean(j.first) === first && j.match(k, inputs));
}

export function normalizeBindingName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * The Cargo action for a Clay action column. Matching is on the job the
 * keywords describe AND on the inputs: a mapping only applies when every
 * required Cargo field has a Clay input to fill it. Keywords alone mapped
 * `apollo-enrich-person` (email in) to LinkedIn profile enrichment.
 * When no inputs are known (inputs is undefined), keywords decide alone.
 */
export function findMapping(actionKey: string, inputs?: string[]): ActionMapping | undefined {
  const k = actionKey.toLowerCase();
  const fits = (m: ActionMapping) =>
    inputs === undefined || m.params.every((p) => !p.required || hasInput(inputs, ...p.clayAliases));
  const mapping = ACTION_MAPPINGS.find((m) => m.match(k) && fits(m));
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
