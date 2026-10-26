# Terms used in the explainer implementation plan

This index explains wording from the candidate-review implementation plan.
Definitions describe intended meanings, not proof of implementation.
Some proposed components still need the reuse audit.

## Acronyms

| Term | Meaning in this project |
|---|---|
| MCP | Model Context Protocol. The interface ChatGPT uses to call our tools. |
| LLM | Large language model. Used here to draft topic ideas and, later, scripts. |
| SDK | Software development kit. Library code for connecting to a service or protocol. |
| CLI | Command-line interface. A way to run the program from a terminal. |
| UUID | Universally unique identifier. An ID used to distinguish requests and records. |
| JSON | JavaScript Object Notation. A text format for structured data. |
| HTTP | Hypertext Transfer Protocol. Used for requests to servers. |
| URL | Uniform Resource Locator. A web address. |
| PR | Pull request. A proposed set of repository changes for review. |
| DB | Database. Used in names such as dbPath. |
| SHA-256 | The hash algorithm used to calculate a content fingerprint. |

## Requests, programs, and saved progress

| Wording in the plan | What I mean | Prefer this wording |
|---|---|---|
| Explainer | The explanation-video format, not a person or agent | Explanation video |
| Explainer job / job | One request to make an explanation video | Video request |
| Job progress / state | Which steps finished and which decision is pending | Saved progress |
| Worker | The program that processes the request, comparable to a queue consumer | Processing program |
| Stage worker / checkpointed worker | A program that executes a production step and saves its result | Program that runs and saves a step |
| One-run helper | The existing helper that starts processing and reports its result | Existing processing helper |
| Stage | A step such as transcript extraction or candidate judgment | Production step |
| Ledger / durable store | A database containing saved progress and decisions | Progress database |
| Durable | Saved so it survives process restarts and removal of the source checkout | Saved outside the checkout |
| Persistence / persist | Write data to storage so a later run can read it | Save |
| Checkpoint | A saved result from which processing can continue | Saved step result |
| Resume | Continue from the last accepted saved result | Continue processing |
| Attempt | One execution of a step, including failed executions | Execution attempt |
| Dispatch | Send a request to a provider or start processing | Send the request / start the step |
| Unknown outcome | We sent the request but cannot confirm whether the provider completed it | Completion is unconfirmed |
| Lease / stage claim | Temporary ownership that prevents two programs processing the same step simultaneously | Temporary processing lock |
| Caller | The code or ChatGPT tool call that starts an operation | Code calling the operation |
| Pipeline / flow | The connected production steps | Production sequence |
| Slice | A portion of the feature we can build and check separately | Implementation part |
| Reuse audit | Trace existing code to identify what to reuse and what is missing | Existing-code check |

## Topics, evidence, and versions

| Wording in the plan | What I mean |
|---|---|
| Candidate / candidate idea | A proposed topic for you to choose. It is not a selected topic. |
| Candidate set | The list of proposed topics returned for review. |
| Candidate selection | Your explicit choice from that list. |
| Source | The supplied YouTube video and its extracted transcript. |
| Source-supported | Supported by what the original video says. It does not establish independent factual truth. |
| Cue | One timestamped transcript entry. |
| Passage / evidence span | Transcript text used to support an idea or claim. |
| Evidence shape | How supporting text is represented, such as one interval or several separate passages. |
| Projection / projected evidence | A selected subset of data sent onward. Here, the cited transcript entries and relevant context. |
| Judgment | Jev's answer to a configured question about a candidate. |
| Ranking | Ordering topics by judgment scores. It does not choose a topic for you. |
| Qualifications | Conditions, exceptions, or limits that an explanation must preserve. |
| Provenance | A record of which source, provider, configuration, and result produced the data. |
| Revision | A particular saved version of a record or its content. Job revisions count updates. Content revisions can use hashes. |
| Stale revision | An older version that no longer matches the current record. |
| Hash / identity | A content fingerprint used to detect changes and identify an exact version. |
| Canonical JSON | JSON written in a consistent form so equivalent data produces the same hash. |
| Immutable revision | A saved version that is not overwritten. Changes create another version. |

## Interfaces, checks, and storage

| Wording in the plan | What I mean |
|---|---|
| Contract / schema | The accepted fields, types, limits, and response format. |
| Adapter | A small translation layer between existing interfaces. |
| Provider | The configured external model service and the code connecting to it. |
| Transport | Code that sends requests and receives responses. |
| Recipe | The configured prompt, response schema, and model settings. |
| Structured generation | Asking the LLM to return data matching a specified schema. |
| Public status / structured content | Data returned through MCP for ChatGPT to present. “Public” does not mean published on the internet. |
| Mutation | An operation that changes saved data. |
| Request deduplication | Recognizing a repeated request and returning its prior result instead of repeating the work. |
| Compare-and-swap | Update a record only if its current revision matches the revision the caller expected. |
| Atomic write / transaction | A change that completes as one operation or fails without a partially accepted result. |
| Orphan file | A saved file that the database does not reference, for example after a crash. |
| Shared data root | The configured permanent storage folder used across source checkouts. |
| Checkout / worktree | A local working copy of the repository. |
| Cross-checkout | Reading saved results from a different working copy of the repository. |
| Credential preflight | Check required authentication before sending a provider request. |
| Fake provider | A test substitute for an external service. No real model request runs. |
| Reconciliation | Compare the feature documentation with actual code and tests. |
| Regression test | Check that an existing behavior still works after a change. |

## Correction to the plan's architecture sentence

Use the existing processing program and saved progress where their interfaces fit.
Add only the missing topic-review and selection behavior.
A separate database or program remains a proposal that needs a demonstrated gap.
