# Airtable Integration System

## 1: Problem Statement

**What are we solving?**

- Integrate deeply with Airtable beyond public APIs
- Sync metadata, records, and revision history
- Handle large datasets safely and efficiently
- Work around Airtable limitations (no public revision API)

**Key Challenges**

- Rate limits
- Missing APIs
- Long-running jobs
- Data consistency

---

## 2: High-Level Architecture

**System Components**

- Frontend (triggers sync & jobs)
- Express.js API (stateless layer)
- Airtable API + Internal Web APIs
- Puppeteer-based Scraping Service
- MongoDB (primary persistence)

---

## 3: Authentication Strategy

**Two Authentication Paths**

1. OAuth2 + PKCE (official & secure)
2. Browser-based login (Puppeteer) for revision history

**Why both?**

- OAuth tokens cannot access revision history
- Browser session cookies unlock internal Airtable endpoints

---

## 4: OAuth2 + PKCE Design

**Why PKCE?**

- Prevents authorization code interception
- Required for public clients

**Flow**

- Generate verifier + challenge
- Redirect user to Airtable
- Exchange code + verifier for token
- Persist tokens securely

---

## 5: Browser Automation & Scraping

**Why Puppeteer?**

- Airtable revision history is web-only
- Requires real browser behavior

**Key Techniques Used**

- Stealth plugin
- Human-like typing delays
- MFA handling
- Cookie extraction & reuse

**Risk Mitigation**

- Cookie validation
- Short-lived sessions
- Rate limiting

---

## 6: Airtable Data Sync Strategy

**What We Sync**

- Bases
- Tables
- Pages (records)

**How**

- Axios for metadata APIs
- Airtable SDK for records
- Bottleneck for rate limiting

**Design Principle**

- Idempotent sync (safe to rerun)

---

## 7: Database Design & Optimization

**MongoDB Usage**

- Collections: Base, Table, Page, RevisionHistory

**Indexes**

- Compound unique index: { baseId, tableId, pageId }
- updatedAt for sorting

**Why bulkWrite?**

- Fewer DB round-trips
- Higher throughput
- Lower cost

---

## 8: Revision History Extraction

**How It Works**

- Call internal Airtable endpoint
- Parse HTML diffs using Cheerio
- Detect assignee & status changes

**Why HTML Parsing?**

- No structured JSON available

**Normalization**

- Convert raw diffs into domain-friendly events

---

## 9: Background Job Processing

**Why Background Jobs?**

- Revision sync can take minutes
- HTTP requests must stay fast

**Implementation**

- Batch processing
- Promise.allSettled
- Progress tracking

**Current State**

- In-memory job tracking

---

## 10: Error Handling & Resilience

**Handled Scenarios**

- Rate limits (429 → retry)
- Cookie expiry (401/403)
- Partial failures

**Key Pattern**

- Fail fast for auth
- Fail soft for data

---

## 11: Performance & Cost Considerations

**Optimizations Used**

- bulkWrite
- Compound indexes
- Batching
- Client-side rate limiting

**Cost Control**

- Minimized DB calls
- Controlled API usage

---

## 12: Scalability & Future Improvements

**If Data Grows 10x**

- Incremental revision sync
- Archive old revisions
- Redis for jobs

---
