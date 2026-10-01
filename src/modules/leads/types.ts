import type { EmailStatus, PersonStatus } from "../../core/enums.js";

/** Filter shared by leads.search, smart lists, exports and campaign enrollment. */
export interface LeadFilter {
  /** Free text over name, email, title and company name. */
  query?: string;
  list_id?: string;
  status?: PersonStatus[];
  tags?: string[];
  min_fit_score?: number;
  max_fit_score?: number;
  has_email?: boolean;
  email_status?: EmailStatus[];
  /** ISO-2 country codes. */
  countries?: string[];
  company_ids?: string[];
  /** Has an active (not dismissed) signal with one of these definition keys. */
  signal_keys?: string[];
  /** Enrolled in this campaign (any status). */
  campaign_id?: string;
  /** Not enrolled in any active campaign. */
  not_in_active_campaign?: boolean;
}

export interface ContactableResult {
  ok: boolean;
  /** Stable snake_case codes, e.g. suppressed_email, excluded_country, consent_required. */
  reasons: string[];
}

export type ContactChannel = "email" | "linkedin";
