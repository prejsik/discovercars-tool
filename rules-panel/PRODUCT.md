# DiscoverCars rules panel

## Platform
Web, desktop-first and usable on mobile.

## Audience and job
The MM Cars Rental operations director reviews and edits pricing rules: allowed
vehicle groups, daily minimum rates, pickup-date periods and rental durations.
The user confirmed that the director will approve changes independently.

## Constraints
The scraper, schedules, broker-markup calibration and confirmed baseline remain
unchanged. An additive, tested scoped-floor contract joins the existing Excel
engine. All displayed rules originate in repository config.
Prices are PLN gross per day. Pickup dates and rental duration are separate.
Protected dates, excluded classes and mandatory overrides must be explicit.
Implementation is local until exact publication/integration approval. No new
messages, infrastructure mutations, Git writes or production price changes are
authorized by the implementation task alone.
Shared drafts and audit live in private storage, never in the public repo.
Do not imply a draft has affected the running tool or DiscoverCars prices.

## Stack
Existing project: Node.js with a Python Excel pipeline. A separate lightweight
web application will isolate the panel from those production dependencies.
React/Vite with local development endpoints. Hosting uses Cloudflare Workers
Static Assets with Cloudflare Access. Production drafts use a private Durable
Object; a single-repository GitHub App publishes only approved policy files.
Live authentication and GitHub publishing require a separate authorized setup.

## Success
The director can find a rule, edit a valid draft, inspect the change and its
applicable dates, check a location/group/duration combination, and export a
proposal. The director sees source/baseline identity, data age and real impact
before approving. Conflicting edits do not overwrite another person's draft.
Rollback creates a new proposal. Current policy files and baseline remain
byte-for-byte unchanged during implementation and preview.

## Voice
Polish operational terminology. Concrete labels, amounts, dates and statuses.
