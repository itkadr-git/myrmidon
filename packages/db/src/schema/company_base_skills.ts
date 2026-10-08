// myrmidon(1.6.5 BASE-SKILLS): the company-level registry of base skills.
//
// A base skill is a skill the company declares as mandatory for every agent:
// the board keeps the list in the interface, and the server makes sure the
// skill is present on every agent — a new one at creation, an existing one when
// the skill is added to the list, and again on demand from the base-skills
// screen. The registry is company-scoped, so a skill that is mandatory in one
// company is not imposed on another.
//
// Why a dedicated table instead of a column on `company_skills`: a base skill
// is a company-level decision about an existing library skill, and the vendor
// table stays untouched, so a vendor sync never collides with our registry.
// `skill_id` cascades: removing a skill from the library also removes it from
// the base list, while `key` keeps the row readable in the audit trail.

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";

export const companyBaseSkills = pgTable(
  "company_base_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySkillUniqueIdx: uniqueIndex("company_base_skills_company_skill_idx").on(table.companyId, table.skillId),
    companyKeyUniqueIdx: uniqueIndex("company_base_skills_company_key_idx").on(table.companyId, table.key),
    companyCreatedIdx: index("company_base_skills_company_created_idx").on(table.companyId, table.createdAt),
  }),
);