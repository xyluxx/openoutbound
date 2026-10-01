import { defineTool, type EngineModule } from "../../core/operation.js";
import { bootstrapJob, ingestJob } from "./jobs.js";
import { archiveLessonsJob, archiveLessonsSchedule } from "./lessons.js";
import { approveSuggestions } from "./operations/approve.js";
import { answerGapOp, dismissGapOp, listGaps } from "./operations/gaps.js";
import { bootstrapKnowledge, ingestKnowledge } from "./operations/ingest.js";
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  getKnowledgeItem,
  listKnowledge,
  searchKnowledgeItems,
  updateKnowledgeItem,
} from "./operations/items.js";
import { createOfferOp, deleteOfferOp, listOffers, updateOfferOp } from "./operations/offers.js";

export const manageKnowledgeTool = defineTool({
  name: "manage_knowledge",
  title: "Knowledge base",
  description:
    "Manages what the engine may say about your own company: facts (about, products, proof, objections, FAQs), hard rules, voice samples, offers and unanswered prospect questions (gaps). Start a new workspace with bootstrap_from_website, review drafts (list with status suggested, list_offers) and approve_suggestions; add single facts with add, documents or PDFs with ingest, and lessons (what worked, guidance for writers) with add kind lesson. Actions: list, search, get, add, update, remove, ingest, bootstrap_from_website, approve_suggestions, list_offers, add_offer, update_offer, remove_offer, list_gaps, answer_gap, dismiss_gap. Not for facts about prospects: use research_lead for those.",
  toolset: "core",
  actions: {
    list: "knowledge.list",
    search: "knowledge.search",
    get: "knowledge.get",
    add: "knowledge.create",
    update: "knowledge.update",
    remove: "knowledge.delete",
    ingest: "knowledge.ingest",
    bootstrap_from_website: "knowledge.bootstrap",
    approve_suggestions: "knowledge.approve",
    list_offers: "offers.list",
    add_offer: "offers.create",
    update_offer: "offers.update",
    remove_offer: "offers.delete",
    list_gaps: "knowledge_gaps.list",
    answer_gap: "knowledge_gaps.answer",
    dismiss_gap: "knowledge_gaps.dismiss",
  },
});

export const module: EngineModule = {
  name: "knowledge",
  operations: [
    listKnowledge,
    searchKnowledgeItems,
    getKnowledgeItem,
    createKnowledgeItem,
    updateKnowledgeItem,
    deleteKnowledgeItem,
    ingestKnowledge,
    bootstrapKnowledge,
    approveSuggestions,
    listOffers,
    createOfferOp,
    updateOfferOp,
    deleteOfferOp,
    listGaps,
    answerGapOp,
    dismissGapOp,
  ],
  tools: [manageKnowledgeTool],
  jobs: [ingestJob, bootstrapJob, archiveLessonsJob],
  schedules: [archiveLessonsSchedule],
};
