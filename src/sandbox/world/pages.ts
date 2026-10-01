/**
 * Canned "home" and "about" pages for every world company, so the sandbox research provider has
 * something to search and fetch without ever touching the network.
 */
import type { WorldCompany } from "./companies.js";

export interface WorldPage {
  url: string;
  title: string;
  text: string;
  /** ISO date; home/about pages are undated (evergreen), unlike news pages. */
  publishedAt?: string;
  companyKey: string;
}

function ecommercePages(company: WorldCompany): WorldPage[] {
  const home: WorldPage = {
    url: `https://${company.domain}/`,
    title: company.name,
    text:
      `${company.name} sells ${company.industry.toLowerCase()} direct to consumers online. ` +
      `Founded in ${company.founded_year}, the team is based in ${company.city}, ${company.country} ` +
      `and runs on ${company.technologies.join(", ") || "a standard e-commerce stack"}.`,
    companyKey: company.key,
  };
  const about: WorldPage = {
    url: `https://${company.domain}/about`,
    title: `About - ${company.name}`,
    text:
      `${company.name} was founded in ${company.founded_year} and has grown to about ` +
      `${company.employee_count} employees. The operations team owns demand planning, replenishment ` +
      `and 3PL coordination across ${company.technologies.join(" and ") || "their commerce stack"}.`,
    companyKey: company.key,
  };
  return [home, about];
}

function dentalPages(company: WorldCompany): WorldPage[] {
  const home: WorldPage = {
    url: `https://${company.domain}/`,
    title: company.name,
    text:
      `${company.name} is a dental practice in ${company.city}, ${company.country}. ` +
      `Rated ${company.rating ?? "4.5"} stars from ${company.reviews_count ?? "dozens of"} reviews. ` +
      `Call ${company.phone} or book online.`,
    companyKey: company.key,
  };
  const about: WorldPage = {
    url: `https://${company.domain}/about`,
    title: `About - ${company.name}`,
    text:
      `${company.name} has served ${company.city} since ${company.founded_year}. The practice uses ` +
      `${company.technologies.join(" and ") || "a practice management system"} to run scheduling and billing.`,
    companyKey: company.key,
  };
  return [home, about];
}

/** Home and about pages for one world company (works for either segment). */
export function buildProfilePages(company: WorldCompany): WorldPage[] {
  return company.segment === "ecommerce" ? ecommercePages(company) : dentalPages(company);
}
