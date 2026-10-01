# Compliance playbook

- Cold B2B outreach is legal in most markets when it is relevant to the recipient's role, identifies the sender, carries a working opt-out and respects objections at once; several EU countries (Germany, Austria, Italy, Spain, the Netherlands, Denmark, Poland, Belgium) require consent even for B2B email.
- The engine enforces the mechanics (footer, one-click unsubscribe, suppression, consent-required countries, source notice, caps, audit log); the user decides the legal questions (lawful basis, which countries and contacts, retention, claims).
- Platform terms matter as much as law: no LinkedIn scraping or Marketing API prospecting, and Google Places data kept only within its caching limits.

Not legal advice: this is a working summary for builders and agents; users must confirm their own obligations with counsel.

## Contents

- [1. Engine enforces, user decides](#1-engine-enforces-user-decides)
- [2. United States: CAN-SPAM](#2-united-states-can-spam)
- [3. EU and EEA: GDPR](#3-eu-and-eea-gdpr)
- [4. Consent countries for B2B email](#4-consent-countries-for-b2b-email)
- [5. United Kingdom: PECR and UK GDPR](#5-united-kingdom-pecr-and-uk-gdpr)
- [6. Canada: CASL](#6-canada-casl)
- [7. Australia](#7-australia)
- [8. AI disclosure](#8-ai-disclosure)
- [9. Platform terms](#9-platform-terms)
- [10. Record keeping](#10-record-keeping)
- [11. Privacy requests](#11-privacy-requests)
- [12. Suppression, erasure and retention](#12-suppression-erasure-and-retention)

## 1. Engine enforces, user decides

Principle: the engine makes the safe path the default and blocks the clearly unlawful one; legal judgment stays with the user.

| Area | Engine enforces by default | User decides |
|---|---|---|
| Identity | Real mailbox and sender name; company line and postal address in every footer; launch blocked without a postal address | Which legal entity sends |
| Opt-out | Visible unsubscribe line, `List-Unsubscribe` with One-Click (RFC 8058), unsubscribe links that keep working (at least 60 days; in practice never expire), suppression at once across all campaigns and channels in the workspace | Whether an agency also shares opt-outs across client workspaces |
| Objection (GDPR Art. 21) | Opt-out line in the first message; "stop" and negative replies suppressed | - |
| Source notice (GDPR Art. 14) | One-line notice with a privacy link for EU, EEA and UK contacts (`gdpr_source_notice`); a source stored for every contact | Privacy notice content; legitimate interest assessment |
| Consent countries | Cold email skipped for `consent_required_countries` (`DE`, `AT`, `IT`, `ES`, `NL`, `DK`, `PL`, `BE` by default) unless `person.custom.consent` is recorded | Whether to add more (section 4); what counts as valid consent evidence |
| UK sole traders | `uk_sole_trader_check` (on): UK businesses without evidence of a corporate legal form are skipped for cold email unless consent is recorded (section 5) | Marking a company as corporate (`custom.legal_form`) |
| Contact pressure | Cap per company (3 active), 30 rest days, one active campaign per person | Tighter settings |
| Deception | Checker blocks fake "Re:" or "Fwd:", unsupported claims and impersonation | Truth of offers and proof in the knowledge base |
| Ad disclosure (US) | `ad_disclosure` footer line for recipients in the listed countries (`US` by default, and when the country is unknown) (section 2) | Wording |
| Canada, Australia | `publication_evidence_countries` (`CA`, `AU`): cold email only with the page where the address was published (`email_source`, recorded by the website crawler) or recorded consent (sections 6 and 7) | Whether to email these countries at all, and whether to crawl them (`crawler_excluded_countries`) |
| AI disclosure | `ai_disclosure` line on replies sent without human review (EU recipients by default) (section 8) | Wording, and whether to extend it to all recipients |
| Data rights | Privacy requests in replies stop all outreach at once and open an urgent problem with the deadline (section 11); audit log, suppression list, erasure that keeps a minimal suppression record, retention sweep after `retention_days` (1095 by default) | Retention period, processor agreements with providers, answering every privacy request within one month |
| Platforms | No LinkedIn scraping, account limits, comment review; Places data limited to `place_id` | Whether to accept LinkedIn automation risk |

## 2. United States: CAN-SPAM

Covers all commercial email, including business-to-business; no consent is needed, but every message must follow the rules ([FTC compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)):
- Accurate header information: From, To, Reply-To and routing must identify the sender.
- No deceptive subject lines: the subject must reflect the content (a fake "Re:" fails this).
- Identify the message as an ad: the law leaves leeway on how, but the disclosure must be clear and conspicuous. The engine adds the configurable `compliance.ad_disclosure` line ("This is a commercial message." by default) for recipients in the listed countries (`US` by default) and when the country is unknown.
- A valid physical postal address (street address, registered PO box or registered private mailbox).
- An opt-out that works for at least 30 days after sending, honored within 10 business days, with no fee and nothing more than a reply or one web page; opted-out addresses may never be sold or transferred.
- Responsibility cannot be contracted away: the company promoted and the sender can both be liable.
- Aggravated violations: sending an otherwise unlawful email to addresses harvested automatically from a site that promises not to share them, or generated by combining names, letters or numbers, adds liability ([15 U.S.C. 7704(b)(1)](https://www.law.cornell.edu/uscode/text/15/7704)). Pattern-guessed addresses look like the second case: verify them, and keep every other rule so there is no violation to aggravate.
- Penalties: up to $53,088 per violating email. The 2025 level still applies because the 2026 inflation adjustment was cancelled ([Federal Register, 15 Sept 2026](https://www.federalregister.gov/documents/2026/09/15/2026-18853/civil-penalty-inflation-adjustments)).

## 3. EU and EEA: GDPR

A named business contact (jane.doe@company.example) is personal data. GDPR applies to people in the EU and EEA even when the sender is elsewhere.
- Lawful basis: legitimate interest (Art. 6(1)(f)); Recital 47 says direct marketing may be a legitimate interest. The CJEU held in C-621/22 (KNLTB, 4 October 2024) that a purely commercial interest can be legitimate without being written into law; necessity and balancing still apply ([DLA Piper summary](https://privacymatters.dlapiper.com/2024/10/eu-cjeu-confirms-that-legitimate-interests-can-cover-purely-commercial-interests/)).
- The EDPB's legitimate interest guidelines (1/2024) are still the consultation draft; the 2026-2027 work programme plans a final version and an EU assessment template ([work programme](https://www.edpb.europa.eu/system/files/2026-02/edpb_work-programme_2026-2027_en.pdf)). The draft says the assessment is made at the outset and documented, and that where ePrivacy rules require consent for marketing email, Art. 6(1)(f) cannot replace it (para. 114) ([draft](https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202401_legitimateinterest_en.pdf)).
- Document a legitimate interest assessment per campaign type: purpose, why the data is needed, and the balance (relevant to the person's role, business context, easy opt-out, minimal data).
- Source notice, Art. 14: when data does not come from the person, tell them who you are, why, the legal basis and legitimate interest, the source of the data, retention and their rights, at the latest at the first communication (Art. 14(3)(b)) ([text](https://gdpr-info.eu/art-14-gdpr/)). The engine's one-line notice plus a privacy link does this.
- Right to object, Art. 21: objection to direct marketing is absolute, and the right must be "explicitly brought to the attention" of the person, clearly and separately, at the latest at the first communication (Art. 21(4)) ([text](https://gdpr-info.eu/art-21-gdpr/)). The opt-out line in the first email does this.
- Requests: access and erasure answered within one month (Art. 12(3)); "where did you get my data" is answered truthfully from the stored source. The engine detects these requests in replies and hands them to the human (section 11).
- Never process sensitive data (Art. 9) or infer it from public posts.
- National ePrivacy rules on email marketing sit on top of GDPR (section 4).
- Enforcement is real: the CNIL fined Kaspr EUR 240,000 in December 2024 for collecting LinkedIn contact details that members had hidden, keeping data for five years renewed at every update, and failing the Art. 12 and 14 information duties ([CNIL](https://www.cnil.fr/en/data-scraping-kaspr-fined-eu240000)); Poland's regulator fined Bisnode just over PLN 943,000 for taking data from public registers without informing the people concerned, upheld after four years in court ([UODO](https://uodo.gov.pl/en/553/1572)). In May 2025 the CNIL fined Solocal Marketing Services EUR 900,000 for campaigns on bought data: it could not show proof of consent for data from one of its main suppliers, and proving consent was its own job ([CNIL](https://www.cnil.fr/fr/sanction-de-900-000-euros-societe-solocal-marketing-services)).

## 4. Consent countries for B2B email

Some countries require prior consent for marketing email even to business addresses. The engine skips cold email to `consent_required_countries` unless consent is recorded; phone, letter and manual tasks remain possible where their own rules allow.

- Germany: section 7(2) no. 2 UWG treats email advertising without the addressee's prior express consent as an unacceptable nuisance, with no B2B exception; section 7(3) allows only a narrow existing-customer exception ([UWG section 7](https://www.gesetze-im-internet.de/uwg_2004/__7.html)). The usual consequence is a costly cease-and-desist letter (Abmahnung) from a competitor or the recipient. B2B phone calls need at least presumed consent (section 7(2) no. 1), a high bar for cold calls. Whether LinkedIn messages count as electronic mail is unsettled; be conservative.
- Austria: section 174(3) TKG 2021 prohibits direct-marketing email (and SMS) without the recipient's prior consent, with no distinction between consumers and businesses; section 174(4) allows a narrow existing-customer exception that also requires the recipient not to be on the national opt-out list ([TKG 2021 section 174](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20011678&Paragraf=174)).
- Italy: Privacy Code art. 130 requires the consent of the "contraente o utente" for marketing email ([art. 130](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2003-06-30;196~art130)), and "contraente" includes legal persons ([art. 121](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2003-06-30;196~art121)); only a narrow existing-customer exception applies.
- Spain: LSSI art. 21(1) bans promotional email the recipient did not request or expressly authorize, with no business exception; art. 21(2) covers existing customers only ([LSSI](https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758)).
- Netherlands: Telecommunicatiewet art. 11.7(1) bans unsolicited commercial email unless the sender can prove prior consent; for companies and professionals, art. 11.7(3) exempts only contact details they designated and published for receiving such messages, and recipients outside the EEA ([art. 11.7](https://wetten.overheid.nl/jci1.3:c:BWBR0009950&hoofdstuk=11&artikel=11.7)).
- Denmark: Marketing Practices Act section 10(1) bars a trader from contacting anyone by email for direct marketing without prior consent; section 10(2) has an existing-customer exception ([Act 426 of 2017](https://www.retsinformation.dk/eli/lta/2017/426)).
- Poland: art. 398(1) of the Electronic Communications Law bans sending commercial information through terminal equipment, including interpersonal communication services such as email, to a subscriber or end user without prior consent; "end user" is defined as any entity using a public communications service, and a breach is also unfair competition (art. 398(4)) ([Dz.U. 2024 item 1221](https://api.sejm.gov.pl/eli/acts/DU/2024/1221/text.pdf)).
- Belgium: opt-in is the rule; the exceptions are existing customers and legal persons reached at a general address such as info@ ([DLA Piper summary](https://www.dlapiperdataprotection.com/index.html?t=electronic-marketing&c=BE)). Treat named work addresses as consent-only.

Opt-out countries, with conditions:
- France: B2B email may rest on legitimate interest when the message relates to the person's profession (the CNIL's example: software pitched to a company's IT director), the person was informed and can object easily; with bought data, check that they were told and could object. Generic addresses (info@, contact@) fall outside these rules ([CNIL](https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique)).
- Ireland: consent for natural persons, except at an address that reasonably appears to be used mainly for work, when the message relates solely to that work (reg. 13(1)-(2)); non-natural persons may be emailed unless they objected (reg. 13(4)) ([S.I. 336/2011](https://www.irishstatutebook.ie/eli/2011/si/336/made/en/print)).
- Sweden: consent only for natural persons (Marketing Act section 19); every marketing email, including to companies, carries a valid opt-out address (section 20) ([SFS 2008:486](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/marknadsforingslag-2008486_sfs-2008-486/)).
- Hungary: prior express consent for direct-contact ads, email included, to natural persons (Advertising Act section 6(1)) ([Act XLVIII of 2008](https://net.jogtar.hu/jogszabaly?docid=a0800048.tv)).

Default setting: `consent_required_countries: [DE, AT, IT, ES, NL, DK, PL, BE]`. Whether named employees count as natural persons in Sweden and Hungary is unsettled; add `SE` and `HU` unless counsel clears it. France and Ireland depend on the offer relating to the person's job: enforce it through the ICP personas and the checker's relevance test. Check any other country before the first send there.

## 5. United Kingdom: PECR and UK GDPR

- PECR splits recipients: sole traders and some partnerships are treated as individuals and may only be emailed with consent (or the soft opt-in for existing customers); corporate bodies (companies, LLPs, Scottish partnerships, government bodies) may be emailed without consent ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/)).
- Every message must identify the sender and give a valid opt-out address; keep a do-not-email list and screen new lists against it.
- UK GDPR still applies to named employees at corporate bodies: legitimate interest assessment, Art. 14 notice and Art. 21 opt-out, as in section 3.
- Engine rule (`uk_sole_trader_check`, on by default): a UK business counts as corporate only with evidence (Ltd, Limited, LLP or PLC in its name, `custom.legal_form`, or 10+ employees); otherwise it is treated as an individual subscriber and cold email is skipped unless consent is recorded.
- Data (Use and Access) Act 2025: since 5 February 2026, breaches of PECR regulations 22 and 23 (among others) carry fines up to GBP 17.5 million or 4% of worldwide annual turnover, whichever is higher, instead of the old GBP 500,000 cap ([Schedule 13](https://www.legislation.gov.uk/ukpga/2025/18/schedule/13), [S.I. 2026/82](https://www.legislation.gov.uk/uksi/2026/82/made)). The same Act adds UK GDPR Art. 6(11), which names direct marketing as processing that may be necessary for a legitimate interest; the test still applies ([section 70](https://www.legislation.gov.uk/ukpga/2025/18/section/70)). Its new soft opt-in is for charities only ([section 114](https://www.legislation.gov.uk/ukpga/2025/18/section/114)).

## 6. Canada: CASL

- Commercial electronic messages need consent, express or implied ([CASL](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html)). The implied consent that fits cold B2B outreach is conspicuous publication: the person published the address, did not say they refuse unsolicited messages, and the message is relevant to their business role (s. 10(9)(b)). Existing business relationships also count, within set periods (two years after a purchase, six months after an inquiry).
- Every message identifies the sender with contact details valid for at least 60 days (s. 6), and includes an unsubscribe mechanism that works for at least 60 days and is honored within 10 business days (s. 11).
- The sender carries the burden of proving consent (s. 13): store the URL where the address was published, the capture date and the absence of a no-marketing statement.
- Penalties up to CAD 10M per violation for organizations (s. 20(4)).
- Engine rule (`publication_evidence_countries` includes `CA`): cold email needs the page where the address was published (`email_source`, set by the website crawler, or `custom.publication_url`) or recorded consent.

## 7. Australia

- Spam Act 2003: no commercial electronic message without consent, express or inferred (s. 16) ([Spam Act](https://www.legislation.gov.au/C2004A01214/latest/text)). Consent can be inferred when the address was conspicuously published by the person or with their permission, the publication does not say they refuse commercial messages, and the message relates to their work role (Schedule 2, clause 4).
- Every message identifies the sender accurately (s. 17) and carries a functional unsubscribe that works for at least 30 days after sending; an unsubscribe takes effect within 5 working days (s. 18 and Schedule 2).
- Part 3 bans supplying, acquiring or using address-harvesting software and harvested-address lists, but only in connection with sending commercial electronic messages in contravention of s. 16 (ss. 20(2), 21(2) and 22(2)). Crawling a company's own site for the address a person published there, and emailing it only with that page as the basis for inferred consent, is meant to stay inside that exception. Keep the page for each Australian address, check that it does not say the person refuses commercial messages (the engine does not check this), and take advice if the exception is unclear for your use.
- Engine rule: as for Canada (`AU` is in `publication_evidence_countries`): the website crawler runs for Australian companies and records the page as `email_source`; paid finders are not used for these people. To stop crawling Australian sites, add `AU` to `data.enrichment.crawler_excluded_countries`; those people then get an address only from a page you record in `custom.publication_url` or with recorded consent.

## 8. AI disclosure

- EU AI Act, Art. 50(1): providers must design AI systems that interact directly with people so that the people are informed they are interacting with an AI, unless it is obvious ([Art. 50](https://artificialintelligenceact.eu/article/50/)). The information is due at the latest at the first interaction (Art. 50(5)). Art. 50 applies from 2 August 2026: the AI Omnibus (Regulation (EU) 2026/1744, in force 27 July 2026) delayed the high-risk rules, not this disclosure ([K&L Gates](https://www.klgates.com/EU-Digital-Omnibus-on-AI-Enters-Into-Force-7-31-2026)). The open-source exemption does not cover Art. 50 ([Art. 2(12)](https://artificialintelligenceact.eu/article/2/)), and fines reach EUR 15 million or 3% of worldwide turnover ([Art. 99(4)](https://artificialintelligenceact.eu/article/99/)). Whether an AI-drafted, human-approved email counts as "interacting" is debated; automated AI replies in a live conversation are closer to it.
- California's B.O.T. Act makes it unlawful to use a bot (an automated online account whose actions are substantially not a person's) to communicate with someone in California "online", meaning on public-facing sites and apps including social networks, while misleading them about its artificial identity to drive a sale; disclosing that it is a bot removes liability ([Bus. and Prof. Code 17941](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=17941)). It fits automated LinkedIn messaging more than email, but the safe rule is the same everywhere.
- Engine and agent rules: never deny being an AI; route "are you a bot?" to a human; keep human review on replies by default; offer a workspace setting that adds an AI-assistance line to automated replies for EU recipients.

## 9. Platform terms

- LinkedIn: section 8.2 of the User Agreement bans bots and automated methods for contacts, messages and engagement, and scraping; Marketing API member data may not be used for prospecting, lead creation or CRM enrichment, nor combined with other data ([restricted uses](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases)). See [playbook-linkedin.md](playbook-linkedin.md).
- Google Maps Platform: no scraping, and specifically no copying and saving of business names, addresses or user reviews; no caching except as the service terms allow ([terms](https://cloud.google.com/maps-platform/terms)). `place_id` may be stored, refreshed when older than 12 months ([place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id)); Places latitude and longitude for up to 30 days; Places content may not be used with a non-Google map ([service terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)). Engine consequence: a Google Maps lead keeps its `place_id`, and every stored field (name, address, phone, email) comes from the business's own website or a registry, cited as the source.
- Yelp Fusion API: no caching or storing of Yelp content beyond 24 hours, no building your own database of business listings, no use in connection with spam, direct marketing or telemarketing (section 5(p)), and no use to train or improve generative AI models without written approval ([Yelp API terms](https://terms.yelp.com/developers/api_terms/), updated Sept 2026). Not a lead source.
- Google News RSS: personal, non-commercial use only; use GDELT or publisher feeds instead.
- Data providers (Apollo, email finders, verifiers): read each provider's terms on storage, resale and permitted use, and name the source category in your privacy notice.
- Crawling: identify the bot, honor robots.txt ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html)) and 429 responses; the engine's safe fetch does this.

## 10. Record keeping

Keep enough to prove, per contact and per message, why you were allowed to send it:
- Contact: source (provider, URL or file), date collected, country, lawful basis and the legitimate interest assessment reference, consent record where required (who, when, how, wording), CASL publication evidence where relevant.
- Message: the exact text sent, footer and notice version, sender, time, approval (who approved, when).
- Opt-outs and objections: timestamp, channel, the message that triggered them, suppression entry.
- Changes: audit log of settings changes (limits, consent countries, removed suppressions), with actor and reason.

The engine keeps most of this (`source`, `source_refs`, `messages`, `approvals`, `suppressions`, `audit_events`); the legitimate interest assessment and consent wording belong in the knowledge base as `rule` items.

## 11. Privacy requests

A reply that asks to delete their data, to see the data held about them, or where their details came from is a privacy request (`privacy_request`, kind `delete`, `access` or `source`), also when it asks to unsubscribe too. "Remove me" or "stop emailing me" alone is an unsubscribe.

What the engine does at once, without a model when the wording is clear:
- Suppresses the address, the person and the LinkedIn profile, marks the person do not contact, stops every sequence and cancels unsent messages and their approvals. Nothing about the request is written to a CRM.
- Opens one urgent `privacy_request` problem with who asked and what, the received date, the deadline (received plus `compliance.privacy_response_days`, 30 by default: GDPR's one month), where their data came from and when, the next step and a suggested reply.
- Notifies at once, again when 7 days or fewer remain, and every day once the deadline has passed.
- Never answers the request itself, not even when the rule for the category is changed: the category is locked.

What the human does, with your help:
1. Answer from their own mail app within the deadline. The suggested reply is a start; the answer must be accurate.
2. `delete`: run `manage_leads` action `forget` with the `person_id`, `dry_run` first, then for real. It resolves the problem.
3. `access`: send what the engine holds (`get_lead` with `response_format` `detailed`), then resolve the problem with `resolve_exception`.
4. `source`: say where the details came from (the problem names it), offer to delete them, then resolve the problem.
5. Never snooze a privacy request past its deadline.

What `forget` does: stops everything; deletes the person with their message content, research, signals, tasks, lead-file facts and notes; replaces their email address and LinkedIn URL with `[erased]` in stored events (so later webhook deliveries carry `[erased]` too), audit entries, problems, finished jobs and decided approvals; keeps only SHA-256 hashes as a block so they are never imported or contacted again; and fires `lead.forgotten` with their CRM record ids and an email hash. The CRM step follows `crm.on_forget`: a problem asking a person (or the agent) to delete the contact (`task`, the default), the engine deleting it through its built-in CRM provider (`delete`), or `nothing` ([playbook-crm.md](playbook-crm.md)). Names and other free text stay in events (90 days), finished jobs (30 days, failed ones 90) and audit entries, and notifications already sent stay with their receivers: cover those in the retention process.

## 12. Suppression, erasure and retention

- Suppress at once on unsubscribe, objection, complaint, negative reply and hard bounce; check suppressions at import, enrollment and again before every send, on every channel.
- Never remove a suppression without a human decision recorded in the audit log.
- Erasure (Art. 17): delete the person's data but keep a minimal suppression record (the address, or a hash of it) so they are never contacted again. After a marketing objection the ICO points to a suppression list rather than erasure, clearly marked so the data is not used for what they objected to ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-object/)); the CNIL recommends keeping objection data at least 3 years, for that purpose only, preferably hashed ([CNIL](https://www.cnil.fr/fr/comment-utiliser-une-liste-repoussoir-pour-respecter-lopposition-la-prospection)).
- Retention: the CNIL's model notice keeps prospect data 3 years from collection or from the prospect's last contact ([CNIL](https://www.cnil.fr/fr/exemple-dinformation-de-prospects-prospection-commerciale-par-voie-postale)); Kaspr's five years, restarted at every profile update, was part of its fine. Use 3 years as the default. The engine runs a daily retention sweep that deletes prospects past `compliance.retention_days` (1095 by default), keeping suppressions, customers and open opportunities.
- Agencies: each client workspace is usually its own controller, so suppressions are per workspace; raise complaints and legal threats to the agency owner as well.

