# Downstream Answer-Quality Check

## plaud-ai-session-001

**Query:** 06-01 meeting MCP testing monthly delivery project priorities astrazeneca

- **grep-first vs as-deployed**: grep-first wins — Answer A provides substantive information on all four requested topics (MCP, monthly commit process, priorities, and AstraZeneca) while clearly noting the date mismatch, whereas Answer B largely declines to answer and claims no AstraZeneca reference exists.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A directly addresses the 06-01 meeting query with detailed, structured information on MCP testing, monthly delivery, project priorities, and AstraZeneca context, while Answer B admits it cannot find the 06-01 meeting and provides less relevant July content.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides a detailed, structured response addressing all the topics in the question (MCP testing, monthly delivery, project priorities, AstraZeneca), while Answer A claims no relevant context exists. Assuming the context did contain this information, B is substantially more helpful; if B fabricated details, A would be safer, but B's specificity and internal consistency suggest it drew from actual context.

## plaud-ai-session-002

**Query:** Brian 1:1 May 18 4pm

- **grep-first vs as-deployed**: as-deployed wins — Both correctly note the absence of specific meeting notes, but B provides more helpful context by citing relevant Brian-related references with dates, giving the user actionable information about what is available.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A provides relevant contextual information about a Brian scheduling conflict while honestly acknowledging the specific meeting isn't confirmed, whereas Answer B simply states no information exists without offering any related context.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Both correctly note that the context lacks specific 1:1 meeting notes, but A provides a cleaner summary of all Brian-related references (including the April 1 check-in), while B focuses only on the May 15 scheduling conflict and adds some speculative detail about rescheduling.

## plaud-ai-session-004

**Query:** I am using CMUX for Claude now, and it seems pretty great. I wonder if Claude needs to know that I'm using CMUX so that it can control opening the browser in a side-by-side split window in the same session, or understand that I'm in a session, or things like that. What can I do to make sure that Claude knows that I'm using CMUX so that it can use it most effectively?

- **as-deployed vs grep-first**: grep-first wins — Both answers give essentially the same recommendations (CLAUDE.md and hooks), but B provides more concrete detail (example CMUX commands, explanation of PostToolUse hook usage) and is more actionable. A adds a claim about Claude later researching CMUX and writing the config, which may be a fabrication not supported by the actual context.
- **grep-first vs full-cov-hybrid**: tie — Both answers contain essentially identical content, structure, and recommendations, with only minor formatting differences. Neither has a meaningful accuracy or helpfulness advantage over the other.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Both answers provide essentially the same core content, but A adds useful additional information about what Claude ultimately did in the session (researched CMUX and wrote configuration to CLAUDE.md with permission), giving the user a fuller picture of outcomes.

## plaud-ai-session-005

**Query:** Take a look at my interactions in the last week that are captured in transcripts from Plaud and stored in my Obsidian Vault (access via carpathi MCP). Identify 5-10 people that deserve a pat on the back.  I need to send appreciation notes in AwardCo. Create a short recognition post that I can send along. Make sure that it uses my voice.

- **as-deployed vs grep-first**: as-deployed wins — Both answers provide essentially the same 8 recognition posts, but A is more transparent about the truncation of Craig Mathis's entry, while B fabricates a partial recognition for Craig that wasn't actually in the source context, which is less accurate.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides all 8 recognitions (including attempts at Oznur and Craig) rather than stopping at 6 complete ones, and uses second-person voice which is more appropriate for appreciation notes sent directly to recipients.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A includes the complete Oznur Aytekin post and uses second-person 'you' voice per the noted follow-up instruction, while Answer B omits Oznur's post entirely and uses third-person, which is less aligned with a personal appreciation note voice.

## plaud-ai-session-006

**Query:** On Tuesday in Architecture Council, there were a bunch of action items that came out of there. I didn't write them down anywhere. Can you get me a list of those action items and which ones are assigned to me and which ones I just need to follow up on? Use the karpathy MCP.

- **grep-first vs as-deployed**: tie — Both answers are essentially identical in content, structure, and accuracy, with only minor wording differences that do not affect helpfulness.
- **full-cov-hybrid vs grep-first**: tie — Both answers are essentially identical in content, structure, and information provided, with only trivial wording differences. Neither has a meaningful advantage in helpfulness or accuracy.
- **full-cov-hybrid vs as-deployed**: tie — Both answers are essentially identical in content, structure, and recommendations, with only minor wording differences that don't affect helpfulness or accuracy.

## plaud-ai-session-007

**Query:** On Friday, Steve Wierig, Matt Newman, and I had a meeting about business context and enterprise context. I need the notes compiled and summarized into a relatively short overview of the key topics and decisions from that meeting. Use my Carpathi MCP to find that.

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides slightly more detail and context (e.g., Michael Ewing as driver, the ~2-week data mining via Adobe Analytics + Datadog, the growth-to-production timeline, permissioned-context governance) while maintaining the same structure and clarity as A.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers cover the same meeting with similar structure, but B provides more depth and specificity (e.g., Michael Ewing as driver, the curator/index pattern, Matt's search question, token math details, and additional action items) while remaining well-organized. The user asked for a 'relatively short' overview, but B's added detail is substantive rather than padding, making it more informative without being excessive.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more detail and specificity (four tiers with cadences, curator/index pattern, token math with quality lift percentage, Matt's search comparison question, PTO note) while maintaining the same structure and accuracy as A. It gives a richer, more useful summary without being excessively long.

## plaud-ai-session-008

**Query:** Using the Carpathi MCP, do you have access to my Claude conversations from yesterday? There was one where I had Claude code go through and set up the MCP, the Workfront MCP in Gemini. Can you find that conversation?

- **as-deployed vs grep-first**: tie — Both answers convey essentially the same information with the same session ID, tool list, and explanation of the server-side $ref issue. The differences are minor formatting choices, with neither being materially more helpful or accurate.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides specific, actionable details about the found conversation (session ID, date, findings, and specific tools that needed disabling), directly answering the user's question. Answer A essentially refuses to answer, claiming the context is incomplete, which is less helpful even if more cautious.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A provides a concrete, useful response with specific session details, the identified issue, and the list of affected tools. Answer B is meta-commentary about not having enough context, which is less helpful to the user asking a direct question.

## plaud-ai-session-009

**Query:** Take a look at the Architecture Council recording in my files. Use the Carpathian MCP and give me a quick list of all the action items from the Architecture Council this morning.

- **as-deployed vs grep-first**: as-deployed wins — Answer A includes two additional action items under Spec Standards (agents asking for clarification when specs are unclear, and extracting specs) that Answer B omits or condenses, making A slightly more comprehensive while otherwise nearly identical.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers are nearly identical, but B provides slightly more specific detail on the spec language categories (customer needs/integration/implementation) and the code validation pipeline components (security, reliability, correctness, etc.), making it marginally more informative.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Both answers are nearly identical in content and structure, but A provides slightly more specific detail (e.g., naming Redrock as the large codebase example, listing the specific validation pipeline components like security/reliability/correctness/spec conformance/tribal-knowledge checks). B is a bit more generic in these spots.

## plaud-ai-session-010

**Query:** Can you find and install the MS Outlook MCP. I would like to have access to my calendar and meeting transcripts.

- **as-deployed vs grep-first**: grep-first wins — Both answers convey the same core information, but B is slightly more accurate by explicitly acknowledging the limitation that it cannot verify the current MCP state and suggesting a fallback if the connector isn't shown, making it more transparent and helpful.
- **full-cov-hybrid vs grep-first**: tie — Both answers convey essentially identical information: the Microsoft 365 connector was already available, OAuth authentication is needed via /mcp, and calendar plus Teams transcripts will be accessible. The formatting and caveats are equivalent in quality.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Both answers convey essentially the same information, but B adds a useful caveat about Teams being the specific source for transcripts, which helps the user assess whether the solution fits their needs. A's note about not knowing current status is also valuable, but B's content-level caveat is more directly actionable.

## plaud-ai-session-011

**Query:** GitLab MCP is still not connecting like it should. I thought that you just fixed this in our last session.

- **grep-first vs as-deployed**: as-deployed wins — Both answers convey essentially the same technical content, but B is more helpful because it explicitly prompts the user to verify whether the manual edits were actually made — directly addressing the user's confusion about why it's still broken. A's mention of a separate 'glab@gitlab-skills' plugin issue is potentially useful but framed as cosmetic, while B's actionable next step is more directly responsive to the user's frustration.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A directly addresses the user's frustration by explaining why the fix didn't take effect (classifier blocked the edit due to PAT exposure) and gives clear manual remediation steps. Answer B contradicts itself by claiming the fix 'was ultimately applied' while the user is reporting it still doesn't work, and spends time on meta-commentary about session records rather than resolving the issue.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides a more actionable next step by explaining that the fix required manual user action and instructing the user to verify the file, which directly addresses why the issue persists. Answer A incorrectly claims the fix 'was ultimately applied' and then contradicts itself, making it less accurate and less helpful.

## plaud-ai-session-012

**Query:** Brian Pino Jeff Brown all hands agenda engineering leads meeting

- **as-deployed vs grep-first**: grep-first wins — Answer B includes all the content from Answer A plus additional relevant details: the Vibe Sprint demo candidates and decisions, the meeting-in-a-box/manager kit context with action items for Michael and Amy, and Bryan's self-acknowledgment about the demo rule. This makes it more comprehensive and helpful for the query.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A includes more comprehensive details, such as the Vivint demo being ruled out, MCP demo deferral reasoning, Michael's assignment to re-share the manager kit link, and Bryan's self-acknowledgment about the 9-minute video, all of which add useful context without sacrificing accuracy.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Both answers contain essentially the same core content, but A includes additional useful details like the manager kit context, Amy's assignment for the summary slide, and the specific demo candidates (Madri's team, Sione, Gagik), making it more comprehensive.

## plaud-ai-session-013

**Query:** meeting ai leadership calibration MCP unity alignment May 18

- **grep-first vs as-deployed**: as-deployed wins — Answer B is more comprehensive, including an explicit attendees section, more detailed action items (MCP Gateway evaluation, Ryan burnout support, MVP agentic assist), and additional open questions, while maintaining the same accuracy and structure as A.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A is more comprehensive, covering all five discussion areas (including Team Health & AI Enablement and Enterprise Context Strategy as distinct sections) with more specific details like named individuals (Kurt Peterson, Art) and concrete examples (Spring upgrade, Xfinity). Answer B is well-organized but slightly less thorough in its coverage of context strategy specifics and calibration examples.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides more structured information with clear attendee identification, a decisions table with owners, and more comprehensive action items with assigned owners. It also captures additional nuance like the product-vs-engineering tension theme, while covering the same content as A.

## plaud-ai-session-014

**Query:** Eric Kubicki spec driven development architecture council

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides more concrete and useful information, specifically citing Irek Kubicki's actual work on spec-driven development and reverse engineering with tools like Meister, Superpowers, B-MATS, and Spec Kit from the June 1 Claude session. Answer B claims no specific contributions are attributed to him, which appears less accurate given A's specific details.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B more accurately reflects the context, noting Irek Kubicki's role as an Architect and correctly linking Architecture Council references (Tom Valletta's action item, sharing transcript). Answer A makes a questionable claim about an '80% adoption goal' and asserts the Architecture Council meeting excluded Kubicki, which appears to be fabricated or overreaching detail.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A provides more specific and useful details about Irek Kubicki's actual work on spec-driven development (reverse engineering, multi-plugin orchestration with Meister, Superpowers, B-MATS, Spec Kit) from the June 1 Claude session, while also correctly noting Tom Valletta's role in presenting to the Architecture Council. Answer B is more hedged and offers less substantive information.

## plaud-ai-session-015

**Query:** meeting Brian DeLorean HAL dark factory architects

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides more specific and helpful detail, including named participants from the Dark Factory Guild meeting and technical details about V1/V2 planning, and importantly clarifies the likely misinterpretation of 'Brian DeLorean' as a person versus Brian Pino plus Project DeLorean.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A provides more comprehensive detail with clearer structure, including specifics about Dark Factory's architecture (modeled on Anthropic Cloud Agents), the Vibe Sprint context, and a helpful summary table, while covering all the same key points as B.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B is more comprehensive, better structured with a clear summary table, provides more context on what DeLorean/Dark Factory/HAL are, and directly frames the information for the architecture meeting. Answer A is accurate but less detailed, though it does helpfully clarify the 'Brian DeLorean' name confusion.

## plaud-ai-session-016

**Query:** Architecture Council meeting May 19 2026

- **as-deployed vs grep-first**: grep-first wins — Answer B provides substantially more detailed, structured, and useful information about the meeting's agenda and context, while still transparently noting the limits of what the source material contains. Answer A is much more sparse and offers little actionable content.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A provides detailed, structured meeting content with participants, topics discussed, and outcomes, reading as an actual meeting summary. Answer B describes only preparation/agenda material and explicitly admits it doesn't cover what was discussed, making it less directly responsive to the question.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides a comprehensive, detailed summary of the meeting's topics, participants, and outcomes, while Answer A only offers fragmentary references and admits limited access to the content.

## plaud-ai-session-017

**Query:** transcript recording Plaud conversation

- **grep-first vs as-deployed**: as-deployed wins — The query "transcript recording Plaud conversation" is ambiguous, but Answer B provides substantive, specific technical details about a Plaud-related project (the sync plugin, the timestamp bug, fixes, and outcome), which is far more informative. Answer A essentially says the relevant content is truncated and unavailable, offering little value.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers convey the same core information, but B provides additional useful detail (the fallback to Tom's handwritten notes in Bryan Pino.md and the specific turn numbers for the Carpathi MCP search) while remaining equally accurate.
- **full-cov-hybrid vs as-deployed**: tie — Without knowing the actual context the user is referring to, both answers are plausible interpretations of an ambiguous query. A interprets it as content from a specific Plaud transcript in a meeting context, while B interprets it as the plaud-sync-for-obsidian plugin project. Each is internally coherent and detailed for its interpretation, so neither can be judged clearly superior.

## plaud-ai-session-018

**Query:** DeLorean stakeholders meeting May 19

- **as-deployed vs grep-first**: as-deployed wins — Both answers cover the same core workstreams and meeting context, but A provides additional accurate detail about subsequent updates to the status doc (the quick reference grid, the 12th workstream on AI Evaluation Framework, removed items), making it more comprehensive and helpful.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides substantially more detail about the meeting, including time, the full list of 11 workstreams identified, and transparency about what source material was actually available. Answer A is more limited and covers only a subset of what B discusses.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides substantially more detail about the meeting, identifying 11+ workstreams with owners, related source materials, and subsequent updates, while transparently noting gaps. Answer A is much sparser and covers only a small subset of what B captures.

## plaud-ai-session-019

**Query:** Architecture Council action items

- **grep-first vs as-deployed**: as-deployed wins — Answer B organizes items by owner making accountability clearer, correctly spells 'Prashob', and cites its sources, while covering essentially the same content as A.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B covers action items from both Architecture Council meetings (May 19 and June 2), while Answer A only covers the May 19 session, making B more comprehensive and helpful.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B covers action items from both Architecture Council meetings (May 19 and June 2) referenced in the context, with clearer topic-based grouping and explicit owners, while Answer A only covers the May 19 meeting and misses the June 2 items.

## plaud-ai-session-020

**Query:** calibration meeting performance

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides substantially more concrete, specific detail from actual calibration meetings, including individual decisions, quartile placements, and distinct meeting contexts, while still including the broader framework that Answer A covers.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A provides a detailed, structured summary of an actual calibration meeting including specific performance decisions, rationale, unresolved issues, and action items—directly addressing the query. Answer B offers more general framework context and acknowledges it lacks specifics about the calibration meeting itself.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more comprehensive detail from the calibration meeting, including additional individuals discussed, cross-group rankings, unresolved issues, and concrete action items with owners and deadlines, making it more useful and actionable.

## plaud-ai-session-021

**Query:** meeting weekly team discussion

- **as-deployed vs grep-first**: as-deployed wins — Answer A covers more weekly meetings (three vs two) with attendees and action items, providing broader and more useful coverage of the requested topic, while transparently noting limitations for the meeting with less data.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more comprehensive meeting summaries with participants, duration, specific action items, and identifies recurring themes across meetings, making it more useful for someone seeking to understand weekly team discussions. Both are formatted similarly, but B's additional structure and cross-meeting synthesis add value.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Answer A provides more detailed, structured summaries with participants, durations, key topics, and action items for each meeting, plus adds value with a recurring themes section. Answer B is less detailed, and its third entry admits limited information without providing much substance.

## plaud-ai-session-022

**Query:** architecture meeting all-hands

- **as-deployed vs grep-first**: grep-first wins — Answer B provides more specific details (e.g., named individuals like Jessica Walker, the May 18 MCP gateway decision, Project Leapfrog, and the manager summit Day 3 ownership) that add useful context, while covering the same core content as A with comparable structure.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides more comprehensive detail across all relevant topics (must-haves, all-hands awareness, hot topics, and supporting context from earlier meetings), while Answer A covers essentially the same ground but with less depth and detail.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B includes all the content from A plus additional relevant details (specifics on each architecture topic) and references to all-hands mentions in other meeting notes, while also clarifying that these are separate meeting types rather than a single event.

## plaud-ai-session-024

**Query:** Claude Code session karpathy

- **as-deployed vs grep-first**: tie — Both answers fabricate plausible-sounding details about sessions we cannot verify; without knowing the actual context, neither can be judged more accurate, and both are similarly structured and detailed.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more specific and actionable details (PIDs, task statuses on a named branch, specific outstanding items, database row counts), and identifies additional root causes like the wrong working directory and missing --project-root argument. Answer A is well-organized but more general and includes some sessions/details that may be less grounded.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more comprehensive and detailed information, covering both the primary debugging session and referencing the earlier intelligence-plan session that Answer A focuses on. It gives concrete technical details, task statuses, and outstanding items, making it more helpful overall.

## plaud-ai-session-025

**Query:** Architecture Council May 19

- **as-deployed vs grep-first**: grep-first wins — Answer B provides a more detailed, structured agenda with specific framing, discussion points, and desired outcomes for each topic, which is more useful for an Architecture Council meeting. Answer A is more of a summary of past discussions and action items, which is helpful but less comprehensive.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B describes what actually happened in the May 19 meeting with specific participants, timing, and detailed topic coverage, while also noting the pre-meeting drafted agenda. Answer A only reproduces a pre-meeting draft agenda and acknowledges it was truncated, providing less accurate coverage of the actual council session.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides a much more comprehensive, detailed, and structured summary of the meeting's topics, participants, and outcomes, while Answer A is shorter and focuses mainly on action items with some content (like MCP Gateway) that appears to come from a pre-meeting agenda rather than the actual meeting.

## entities-001

**Query:** Hamilton Lucas Jonathan Raymond K8s Kubernetes deployment namespace enterprise-context

- **as-deployed vs grep-first**: grep-first wins — Both correctly note the absence of the named individuals, but B provides additional useful context about the Kubernetes deployment, namespace, ArgoCD setup, and tooling relevant to the enterprise-context project, making it more helpful overall.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers correctly note that Hamilton, Lucas, Jonathan, and Raymond are not in the context, but B provides substantially more detailed and useful information about the enterprise-context Kubernetes deployment, including commands, failure modes, Vault paths, and organized contact tables.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Both correctly note the names aren't in context, but A provides substantially more useful information about the enterprise-context Kubernetes deployment itself, while B fabricates specific details (e.g., Tom Valletta as 'primary engineer', Matt Newman as MR reviewer) that appear speculative.

## entities-006

**Query:** ai-dev-us cluster Workfront k8s wfk8s deployment MCP review app

- **grep-first vs as-deployed**: as-deployed wins — Both answers cover similar ground accurately, but B adds useful details (F-16 IAM gate, environment list, two-layer deploy truth pattern) and ends with clarifying questions appropriate to the vague query, while A includes a less relevant MR !21 tangent.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more actionable detail about the deployment reality (two-layered CI vs infra-access, the prescribed bootstrap sequence, F-16 IAM gate, and A/B eval metrics) while also being clearer about what the context does not cover regarding review apps. Answer A includes a useful kubectl skills table but is less comprehensive on the deployment and MCP validation specifics.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides slightly more specific detail (environment list: qa/hub/preview/prod/sandbox/staging/td, the argocd-mcp tool requirement), correctly distinguishes ai-dev-us as the team tag rather than conflating it with the cluster, and closes with a clarifying question that is appropriate given the ambiguous query. Answer A is comparable but speculates about referenced files not provided.

## entities-007

**Query:** enterprise-context namespace Ethos Flex cluster Workfront K8s

- **grep-first vs as-deployed**: grep-first wins — Answer A provides more comprehensive and structured information including specific tooling details, escalation contacts, IAM group requirements, and MR references, while both honestly acknowledge missing Ethos/Flex cluster details. Answer B adds a useful wfk8s.com domain detail but is otherwise thinner on operational context.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A provides substantially more detail about the enterprise-context namespace (ArgoCD access requirements, IAM groups, Vault paths, bootstrapper MR), the tooling stack (wf CLI, kubectl, argocd, vault), and escalation contacts, while being equally transparent about the lack of Ethos/Flex cluster documentation. Answer B is accurate but much thinner in useful content.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A provides more comprehensive information with a clear summary table, explicitly lists what is and isn't confirmed by the context, and organizes the findings more helpfully. Both acknowledge the same limitations, but A is more thorough and useful.

## entities-008

**Query:** enterprise-context namespace Kubernetes Ethos Flex cluster

- **as-deployed vs grep-first**: as-deployed wins — Answer A extracts and presents concrete details found in the context (project path, Vault path, ArgoCD, kubectl context, wfk8s domain pattern, wf gimme-k8s-creds command) while also acknowledging limitations. Answer B mostly says the context is empty and provides no substantive information, making it less helpful.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more specific and useful information by identifying the 'Enterprise Context Library'/'Enterprise Cortex' as a tangentially related concept found in the context, while still being clear about what's missing. Answer A is accurate but offers less concrete detail from the available context.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B extracts substantially more concrete information from the context (cluster domain patterns, kubectl context, ArgoCD, Vault path, wf gimme-k8s-creds tool) while still honestly noting the limitations regarding Ethos/Flex specifics. Answer A largely disclaims without surfacing the useful details that were apparently available.

## entities-009

**Query:** not contributing AI behind skeptic not there yet coasting

- **grep-first vs as-deployed**: grep-first wins — Answer A directly identifies the person matching the cryptic descriptors (not contributing to AI, skeptic/not there yet, coasting) with specific supporting details from the meeting notes, while Answer B claims no relevant information exists.
- **full-cov-hybrid vs grep-first**: grep-first wins — The query appears to be shorthand referencing specific meeting notes about an individual, and Answer B correctly identifies Matt Winchester with specific details matching all the descriptors (skeptic of AI, not there yet, coasting). Answer A provides general thematic content but misses the likely specific referent of the question.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly addresses the cryptic query by mapping each phrase to relevant content in the source (productivity disparity/coasting, Anjul's skeptic position), while Answer A claims no relevant information exists, which appears to be incorrect given B's substantive citations.

## entities-010

**Query:** Jeff Brown MCP consolidation AI tools guild leading

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides specific, detailed information directly tying Jeff Brown to MCP tool consolidation (79 to ~26 tools) with concrete action items from meetings, while Answer B claims no such connection exists and instead describes Jeff in an unrelated role, which appears to contradict the evidence Answer A cites.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A directly addresses the query by citing specific meeting notes showing Jeff Brown proposed consolidating 79 MCP tools to 26, which is exactly what the question asks about. Answer B claims no such connection exists and misattributes MCP work to others, appearing to miss the relevant context.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A provides more comprehensive detail, including Jeff's role in the May 18 meeting on MCP tool conventions and the scoping decision, while both correctly note the absence of guild-leading information.

## entities-011

**Query:** context fabric AEP cross-product context initiative

- **grep-first vs as-deployed**: grep-first wins — Answer A provides specific, concrete details about the AEP 'enterprise context fabric' meeting, named participants, and action items, directly addressing the query. Answer B claims the term 'fabric' doesn't appear in the notes and offers less relevant information, suggesting it either had different context or failed to surface the pertinent details.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more comprehensive detail with specific quotes, performance metrics, and connects multiple meetings to explain the cross-product vision across AEP/AEM/Workfront. Answer A is more focused but narrower, while B better addresses the 'cross-product' aspect of the query.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides substantially more relevant detail from the source material, including specific quotes, performance metrics, and connections between meetings, while still noting the limitation that no formal charter exists. Answer A largely disclaims having information and offers only one brief quote.

## entities-012

**Query:** monolith scaling cost per feature instrumentation

- **as-deployed vs grep-first**: grep-first wins — Answer B provides more specific, detailed information from the meeting notes about the cost-per-feature framework and instrumentation gap, including the historical modeling approach and levers for reducing cost. Both correctly note the absence of monolith scaling content, but B's substantive detail makes it more helpful.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A provides more comprehensive detail from the meeting notes, including specific historical modeling approach, future model considerations, and concrete guidance on how to reduce cost per feature, while both correctly note the absence of monolith scaling content.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B surfaces additional relevant context from the vault (monolith breakdown references and MongoDB/Kafka scaling) that directly connects to the 'monolith scaling' part of the question, while still clearly delineating what isn't covered. Answer A covers only the cost/instrumentation piece and dismisses the monolith angle entirely.

## entities-015

**Query:** Hovhannes Babayan Hovannis GenStudio impact

- **as-deployed vs grep-first**: grep-first wins — Answer B provides richer context by including Jeff Brown's acknowledgment, framing the visibility gap as 'his single biggest lever,' and noting the Confluence search absence, while still covering the same core facts as A. It also more accurately attributes the calibration advocacy to the manager rather than assuming the reader is the user.
- **grep-first vs full-cov-hybrid**: grep-first wins — Both answers convey essentially the same information, but A is slightly more thorough, explicitly noting the 'rising leader' designation, the phrase about visibility being 'his single biggest lever,' and the absence of authored Confluence pages, giving a fuller picture.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides more detail, including the additional context that Hovhannes had shifted back from GenStudio to Workfront UI work, and more precisely attributes the calibration quote to the user rather than 'his manager'. Both share the same caveat about lack of specifics.

## entities-017

**Query:** monolith scaling must-have priorities

- **grep-first vs as-deployed**: grep-first wins — Answer A directly surfaces relevant context about monolith decomposition and scaling from Tom Valletta's notes and the architecture workshop, and derives implied priorities from that material. Answer B pivots to unrelated 'must nail' priorities that have nothing to do with monolith scaling, making it less relevant.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides specific, actionable priorities grounded in concrete meeting context (reusable code-writing component, non-monolith-first strategy, context packaging gap), while Answer A largely disclaims that no such list exists and offers only vague implied priorities.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Answer A directly addresses the question with specific, substantive priorities drawn from a relevant meeting, while Answer B admits it cannot find the topic and offers only tangentially related items. Assuming A's citations are accurate, it is far more helpful; B's honesty about missing context is valuable but less useful.

## entities-018

**Query:** Araik Kutunian architect

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides substantive details about Araik Kutunian's work (TMS spec-driven development, MR risk scoring, latency investigation) while acknowledging name spelling variations, whereas Answer B claims no information is available, making A more helpful assuming the context supports it.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides substantive information about the likely person (with a name-matching caveat), while Answer A essentially declines to answer. B is more helpful while still being transparent about uncertainty.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides more specific and detailed information from the context, including concrete technical details about the projects, vacation dates, and acknowledges the name spelling variations while still directly addressing the query. Answer A is more hedging and provides less specific detail.

## entities-019

**Query:** AMGOS RCAS governance

- **grep-first vs as-deployed**: as-deployed wins — Answer B surfaces an actual reference to AMGOS in the context (the Arrow v2/Phase 3 audit comparison), providing more useful information, while Answer A incorrectly claims AMGOS is not mentioned anywhere.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A correctly identifies references to AMGOS in the context (Arrow v2 Phase 3 audit) and separately explains RCAs, while Answer B incorrectly claims AMGOS is not mentioned anywhere. A is more accurate and informative.
- **as-deployed vs full-cov-hybrid**: tie — Both answers convey essentially the same information: they identify the separate references to AMGOS and RCAs in the context, note the absence of governance information, and reach the same conclusion. Differences in structure and phrasing are minor and neither is meaningfully more helpful or accurate.

## entities-020

**Query:** Araik Kutunian

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides substantive, specific information about Araik Kutunian's work (TMS spec-driven development, MR risk scoring, Datadog investigation, vacation dates), while Answer A claims no information is available. Assuming B's details are grounded in the context, it is far more helpful.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides some contextual information (that Araik Kutunian appears in a list of architects) while honestly acknowledging the limits of the available data, whereas Answer A dismisses the question entirely by referencing a different person and offers no useful information.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides substantive information matching the likely person referenced (despite spelling variations), while Answer A incorrectly claims the PDFs couldn't be decoded and refuses to answer. B is more helpful assuming the underlying notes were accessible.

## hot-topics-001

**Query:** what recent decisions have I made about MCP server architecture

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides specific, organized details about recent MCP server architecture decisions across both personal and work contexts, directly addressing the question. Answer B claims no relevant information exists, which is less helpful assuming A's context is accurate.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B actually extracts relevant information from the context about MCP server architecture decisions (MR !15, link-surfacing logic, confirmation prompts), while Answer A incorrectly claims no such information exists.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides a more comprehensive and organized summary of recent MCP architecture decisions, distinguishing between the personal project and work contexts, and lists concrete decisions with reasoning. Answer A focuses narrowly on one truncated session and provides less actionable information.

## hot-topics-002

**Query:** what is the current state of the Workfront MCP gateway project

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides a more complete picture, including explicit remaining work items (publish to gateway, recommendations to other MCP teams, coordinated toggle strategy), while B is slightly vaguer about next steps and includes a questionable future date reference.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides a more current and detailed status update (July 6, 2026) with specifics on what's working, what's broken, and concrete next steps, while Answer A focuses on an older session and explicitly acknowledges lacking newer information.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more concrete, dated status information including what's working, what's broken, and specific next steps, giving a clearer picture of the current state. Answer A focuses more on architectural background and general problems being solved rather than the actual current status.

## hot-topics-003

**Query:** what are the hottest topics I have been working on recently

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides concrete, quantified data (chunk counts, percentage shares, cluster identification) from what appears to be a structured weekly digest, and transparently notes the weak signal caveat. Answer B relies on only two sources and admits limited context, making it less authoritative as a summary of 'hottest topics.'
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly references a specific Hot Topics digest with concrete metrics (chunk counts, share percentages) and identifies clear top themes, which is more precise and useful. Answer A appears to synthesize from scattered sources and acknowledges limited context, making it less authoritative.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Both answers contain essentially the same substantive information, but B provides additional useful context (total chunks of 2,482, number of clusters identified) and more clearly flags the weak signal caveat as a distinct note.

## hot-topics-005

**Query:** what have I been doing with the AI engineering curriculum

- **as-deployed vs grep-first**: as-deployed wins — The question asks 'what have I been doing,' and Answer A directly addresses the user's activities across multiple time points (designing, internal review, Confluence publishing, coordination). Answer B provides more curriculum detail but attributes the work to Tom Valletta and explicitly says it can't identify 'I,' making it less responsive to the question.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly addresses the user's question by identifying them as Tom Valletta and framing the activities as their own work, while Answer A explicitly disclaims knowledge of who 'I' refers to, making it less responsive despite containing similar factual content.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B covers more of the user's activities across a longer timeframe (design, internal review, org launch planning, Confluence publishing, coordination syncs), while Answer A is limited to the May 18 meeting. B is more comprehensive and appears equally accurate.

## hot-topics-006

**Query:** what are the active projects in my vault right now

- **as-deployed vs grep-first**: grep-first wins — Answer B surfaces more project references from the retrieved context while still being appropriately transparent about the lack of a dedicated projects index, whereas Answer A only identifies one project and acknowledges less useful information.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly identifies specific projects marked as active with concrete locations and acknowledges its limitations, while Answer A explicitly disclaims being able to answer and instead lists incidentally-mentioned topics that aren't clearly projects. B is more directly responsive to the question asked.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B identifies two active projects (control-center and 2nd-brain) while Answer A only identifies one, missing the 2nd-brain project that was apparently marked as active in the extracted entities. Both acknowledge the same limitation about the truncated directory listing.

## hot-topics-007

**Query:** summarize what I have been focused on this week

- **grep-first vs as-deployed**: grep-first wins — Answer A is more detailed and specific (e.g., mentions Argo CD secrets, spot bonuses with named individuals), and provides a concrete week reference. Answer B adds a 'Horizontals' section that appears more speculative and less tied to this week's specific focus.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A directly addresses the question with a detailed, organized summary of focus areas, while Answer B hedges heavily and provides much less information, only citing older notes and asking for clarification instead of attempting a useful summary.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides a comprehensive, well-organized summary of recent work across multiple areas, directly addressing the user's request. Answer A is overly cautious, limits itself to a single meeting note, and largely deflects the question rather than synthesizing available information.

## hot-topics-008

**Query:** what did I work on most in the last two weeks

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides more concrete, quantitative data (a percentage breakdown of work areas) and also acknowledges limitations clearly, while Answer A is vaguer and relies on only a couple of meeting notes without a real breakdown of work.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B grounds its response in actual context (specific dates, meetings, and projects like the Unity Initiative) while honestly noting the limits of the available information. Answer A presents a suspiciously precise percentage breakdown that appears to be pulled from a prior session about a different time period, making it less trustworthy despite its caveat.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides the same June 1 breakdown but adds additional relevant context from mid-June activities (HackStudio, KR simplification, OKR priorities), giving a more complete partial picture of the two-week window while being equally transparent about the limitations.

## decisions-001

**Query:** AI code review production readiness trust

- **as-deployed vs grep-first**: as-deployed wins — Answer A synthesizes across multiple meetings (April 2, April 13, March 10, May 19) to provide a more comprehensive picture of decisions, the emerging trust framework, and open questions, while Answer B is narrower, drawing mainly from the May 19 agenda.
- **grep-first vs full-cov-hybrid**: grep-first wins — Both answers cover essentially the same content, but A is slightly better organized with clearer numbering of the key questions and more explicit framing of the tiered policy question as a distinct discussion point.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A provides a more comprehensive synthesis, covering the trust framework being developed, specific action items, ownership questions, and the tension between velocity and safety, while still including the key points from Answer B. Answer B is narrower in scope and focuses mainly on the Architecture Council agenda framing.

## decisions-002

**Query:** Nothing should be blocked. Fix it. Connect to MongoDB locally, pull the anthropic keys from my local vault, the WF Planning MCP gateway was setup in the prior project (before they were merged). It is at `~/dev/wf-business-context`. There were some scripts to make sure that the credentials were up to date. I need you to get that all setup and then give me clear instructions for my team mates.

- **as-deployed vs grep-first**: grep-first wins — Both answers reach the same conclusion about insufficient context, but B is more thorough and precise: it explicitly lists all missing artifacts, notes the truncation in the log, and points to more specific files (including the scripts directory and profile examples) for the user to check.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Both answers correctly identify that they lack live access and refer the user to files produced in a prior session, but A is more helpful by providing concrete next-step commands (running setup-env.sh and refresh-wf-token.sh) and suggesting Claude Code as the appropriate tool, while B stops at describing what's missing.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Both answers correctly identify that they cannot execute the task from a read-only context, but A provides more actionable next steps (specific commands to run, suggestion to use Claude Code with shell access) while B mostly restates limitations without giving the user a clear path forward.

## decisions-003

**Query:** Using the Atlassian MCP and the Adobe Wiki that's on Confluence, find any details about the analytics that are on Workfront. Do you have a link to the analytics, like the CJA stuff that we have running on Workfront? Can I get user-level detail off of that? Or would I need to go to something like Datadog to get specific details about how a user is using Workfront?

- **as-deployed vs grep-first**: as-deployed wins — Answer A provides substantive, specific information (wiki link, field names like endUser.visitorId, contacts for provisioning, VPN note, and the CJA vs Datadog distinction) while transparently noting its limitations. Answer B refuses to answer at all, which is less helpful if A's details are indeed drawn from the available context.
- **full-cov-hybrid vs grep-first**: grep-first wins — Both answers correctly identify that the Confluence page content wasn't captured and reach the same conclusion. B is slightly more precise by referencing specific turn numbers and the 'Pending extraction' note, while A includes a potentially fabricated session ID and date that may not be accurate.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A provides concrete, actionable details (wiki link, CJA field for user identification, provisioning contacts, and the CJA vs Datadog distinction) that directly address the user's questions, while Answer B refuses to answer citing missing context. Even if A's details are partially reconstructed, it acknowledges its limitations at the end and still delivers substantive value.

## decisions-004

**Query:** It looks like the pods are showing healthy in QA, but the pipeline still seems to have some issues. Please investigate these issues to see if the pods are actually healthy and functioning, or if they are simply passing a health check that makes them appear healthy. See what you can find and identify all of the issues or concerns that might need to be addressed.

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides more specific technical detail (naming specific environment variables like SINGLE_STORE_REPORTING_DATABASE and SINGLE_STORE_CONTEXT_DATABASE, explaining why the probes were shallow, and noting the communication to specific team members) and includes a clearer summary that directly addresses the user's question about whether pods were truly healthy or just passing superficial checks.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more comprehensive detail, including the additional finding about MR #13 and the tool-reduction concern, and mentions the specific health endpoints and human notification actions. Both cover the core issue similarly, but B is more thorough.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B is more focused and accurate to the question asked, providing clearer detail on the health check issue and its dependencies. Answer A includes MR #13 about tool-reduction which seems tangential to the pod health investigation and adds noise rather than clarity.

## decisions-005

**Query:** [Image #1] [Image #2] The GitLab pipeline still seems to have some issues. Matt Newman sent me these errors. It seems like we have not configured our vault secrets correctly. Can you take a look and see if this is the only problem and how we would fix it. Use the Adobe Wiki, Fluffyjaws and Slack for finding answers.

- **as-deployed vs grep-first**: grep-first wins — Both answers contain essentially identical technical content, but B is organized more clearly with the 'only problem' conclusion stated upfront in the root cause section and the fix steps presented as a cleaner bulleted list, making it slightly more readable.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers contain essentially the same technical content and fix, but B is better organized — it explicitly addresses the user's question 'is this the only problem?' as a distinct section at the end, making it easier to find the direct answer.
- **full-cov-hybrid vs as-deployed**: tie — Both answers are essentially identical in content, structure, and recommendations, with only trivial wording differences. Neither provides any meaningful advantage over the other.

## decisions-006

**Query:** All right, using the Atlassian MCP and any other tools that you feel are useful, try to find out how I would connect to the new Workfront MCP gateway and connect our MCP servers. I want to be able to connect them to Cloud Code, and I also want to be able to set them up in another coding harness someplace else.

- **as-deployed vs grep-first**: grep-first wins — Both answers contain essentially identical information, but B is organized more clearly with better sub-headings for each harness type and includes the additional useful detail of running mcp-remote directly from the command line. The structure makes it easier to follow the two paths and their respective harness configurations.
- **full-cov-hybrid vs grep-first**: tie — Both answers contain essentially identical content, configurations, endpoints, and caveats. The organization is slightly different but neither is meaningfully more helpful or accurate than the other.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Both answers contain essentially identical content, but Answer A has slightly better organization with clearer section separators, a dedicated 'Further Detail' section, and uses a warning emoji to highlight the VPN requirement, making it marginally more readable.

## decisions-007

**Query:** Using the Atlassian MCP and the Adobe Wiki, try to find out: I have a Maestro or a Workfront Hub key and an IMS key, but it doesn't have the right access to Workfront Planning. What do I have to do to make sure that the workspaces I need access to are available to the IMS key that I have set up?

- **grep-first vs as-deployed**: tie — Both answers are essentially identical in content, structure, and accuracy, covering the same three steps, permission table, license note, and common mistakes with only trivial wording differences.
- **full-cov-hybrid vs grep-first**: tie — Both answers provide essentially identical content, structure, and guidance covering the OAuth credential setup, service account classification, and workspace sharing steps. There is no meaningful difference in accuracy or helpfulness.
- **full-cov-hybrid vs as-deployed**: tie — Both answers provide substantively identical content, structure, and recommendations with only minor formatting and wording differences. Neither is more accurate or helpful than the other.

## decisions-008

**Query:** Use my control center vault and get the Fable 5 key from there. Provide the credentials and the setup into a Pi harness that's running locally. Pi can support any LLM, and I would like to use the AWS Bedrock Fable 5 credentials. I'd like to use that model in Pi. Can you make that happen?

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides more actionable detail, including the working command pattern and a concrete next step referencing the follow-up session's successful vault test, while maintaining the same transparency about inability to execute.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A provides the concrete setup commands (export and pi invocation) the user needs to actually use the model, while also being honest about the truncation. Answer B is more vague, omits the actionable command, and claims it cannot execute anything without giving the user the recipe to run themselves.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B is more transparent about its inability to execute the task in the current context and provides more actionable follow-up guidance, while Answer A implies partial completion and makes a questionable claim about the ABSK prefix being the complete token without clear evidence.

## decisions-009

**Query:** It looks like the Argo CD MCP is not particularly useful. Please remove, disable, or turn it off. Let's either find a Claude Code skill for Argo CD on the internet or build one ourselves. If we need to install the Argo CLI, let's go ahead and do that, but let's abandon the Argo CD MCP.

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides more concrete, actionable information including the specific MCP config entry, confirmation that the Argo CLI was already installed, and useful verification commands. Answer A is more cautious but essentially just says 'I don't know the outcome,' making it less helpful even if both acknowledge context limitations.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A honestly reports what can be verified from the truncated context and clearly states the outcome is unknown. Answer B makes specific factual claims (removal from ~/.claude.json, Homebrew v3.4.4, existing helper scripts) that appear fabricated since B itself admits the outcome summary is blank, making it less accurate.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B is clearer and more accurate about what the context shows: it correctly notes the CLI was kept (not just previously installed) and provides more detail on supporting scripts. Answer A's verification suggestion is helpful, but B is more precise about the session's actions and limitations.

## decisions-010

**Query:** I just installed DroidCam on this computer and I can't find it or figure out how to run it. It went through the package installer and I don't know where it is. Can you look for it and see if you can find it?

- **as-deployed vs grep-first**: grep-first wins — Both answers provide the same core information, but B includes additional useful technical details like the package identifier (com.jmkauf.Loopcamera), making it slightly more thorough and helpful.
- **full-cov-hybrid vs grep-first**: grep-first wins — Both answers convey essentially the same information, but B includes the additional detail of the package identifier (com.jmkauf.Loopcamera), making it slightly more complete and informative.
- **full-cov-hybrid vs as-deployed**: tie — Both answers provide identical information about DroidCam being installed as Loopcam.app, the same location, launch methods, developer, and version. The content and helpfulness are essentially equivalent, with only minor formatting differences.

## decisions-011

**Query:** See if you can find and install a Fluffy Jaws MCP from Adobe sources. It is an internal MCP, so you might have to check the Wiki or Slack, but I would like to use it.

- **as-deployed vs grep-first**: grep-first wins — Answer B accurately reflects that the install was blocked by the auto-mode classifier and provides the concrete steps the user needs to run themselves. Answer A contradicts this by claiming the install, authentication, and registration were completed, which appears to be a fabrication of the session outcome.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers convey the same information from the session log, but B is more transparent about its limitations—clearly stating it cannot perform actions and explicitly warning that the URLs/commands may not be current and should be verified. This added epistemic caution makes it more helpful and accurate.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Without seeing the actual session log, both answers reference it, but B provides a more complete account of what was accomplished (install, auth, config, verification) and identifies the one remaining action (restart), while A incorrectly claims the previous session was blocked and leaves the user to redo everything. B's actionable verification commands are also more useful.

## decisions-014

**Query:** Using the Adobe Wiki on confluence, find out how to setup the workfront MCP gateway and the workfront MCP for claude code. Then set it up.

- **as-deployed vs grep-first**: tie — Both answers convey essentially the same information with the same structure, endpoints, commands, and caveats. Neither has a meaningful advantage in accuracy or helpfulness.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A is slightly more helpful because it includes an additional step (checking existing MCP configuration via 'claude mcp list') and explicitly mentions searching Confluence, giving a more complete picture of the process. Both answers are otherwise substantively identical in accuracy and caveats.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Both answers convey essentially the same information, but B is better organized with clearer section headings that separate what was found on Confluence, what was already configured, and what was done. B also more accurately frames the deprecated Kong page finding without introducing a possibly fabricated session date/ID as A does.

## decisions-015

**Query:** It seems like we need an update command in the CLI. Would you add that and then run the vault test to verify the key?

- **as-deployed vs grep-first**: grep-first wins — Both answers describe essentially the same sequence of events, but Answer B is more careful and transparent — it explicitly notes that the actual code diff isn't in the provided context, avoiding overstatement. Answer A claims 'three edits' with a specific pre-existing bug fix inline, which may be an overconfident reconstruction.
- **full-cov-hybrid vs grep-first**: grep-first wins — Both answers describe the same sequence of events with similar accuracy, but B is more transparent by explicitly noting that the actual code diff was not included in the context, which is a helpful caveat for the user.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides a more detailed and accurate chronology, including the fallback to a direct curl call when the CLI test failed due to the type mismatch, and shows the specific commands used. Answer A glosses over this with vaguer wording about an 'API call' confirming the key.

## decisions-016

**Query:** I don't see GitHub or GitLab on the list of MCPs. I just added them. Is something wrong, or where can I find them?

- **grep-first vs as-deployed**: grep-first wins — Both answers give the same core advice about restarting, but A is more specific and actionable regarding the GitLab token caveat (naming the token prefix and suggesting a concrete fix), whereas B only vaguely mentions a possible token issue.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides a concrete, actionable explanation (MCP servers load at startup, restart required) that directly addresses the user's question, while Answer A speculates about connection failures and admits it cannot determine the cause.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides a direct, actionable solution (restart required for MCP servers to load) which is the actual known behavior of MCP configuration. Answer A speculates about Docker and gh CLI issues without confirming the resolution, making it less helpful.

## decisions-017

**Query:** Using the Atlassian MCP and the Adobe Wiki and Confluence, find the GitLab repo for the Workfront MCP.

- **as-deployed vs grep-first**: as-deployed wins — Answer A directly provides a specific GitLab repository URL as requested, while Answer B refuses to answer by citing incomplete context. Assuming the underlying search did surface the repo, A is more helpful; B's meta-commentary about session logs is not what the user asked for.
- **grep-first vs full-cov-hybrid**: tie — Both answers convey essentially identical information with the same structure, caveats, and references to the two partial repo names found; neither provides more helpful or accurate content than the other.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — Answer A directly provides a concrete GitLab repo URL as requested, while Answer B refuses to answer citing incomplete context. Assuming the tools were actually used, A is more helpful and responsive to the user's question.

## decisions-018

**Query:** using the carpathi mcp, find details about the AI Collaborators project. What does it actually do?

- **grep-first vs as-deployed**: tie — Both answers convey essentially identical content, structure, and quotes with only minor stylistic differences; neither is meaningfully more accurate or helpful than the other.
- **full-cov-hybrid vs grep-first**: tie — Both answers contain essentially identical content, structure, and detail, with only minor cosmetic differences in formatting and ordering. Neither is meaningfully more helpful or accurate than the other.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Both answers are nearly identical in content and structure, but B is slightly more helpful because it explicitly notes the sources (March definition meeting and May rollout meeting from the vault) retrieved via the Carpathi MCP, giving better provenance for the information.

## decisions-019

**Query:** What is the mechanism that triggers the curator when a new file shows up in the vault?

- **grep-first vs as-deployed**: grep-first wins — Both answers convey the same core information and acknowledge the truncation, but A is slightly more helpful by explicitly noting which files were examined and suggesting how to get a complete answer.
- **grep-first vs full-cov-hybrid**: tie — Both answers convey essentially identical information: the chokidar watcher in watcher.ts started by the MCP server, with the same caveat that the downstream chain to the curator is not in the provided context. Neither is meaningfully better.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Both answers convey essentially the same information and acknowledge the truncation, but B is slightly more helpful by explicitly citing the source session file and clarifying that the original assistant response was truncated, giving the user better context about why information is missing.

## decisions-020

**Query:** What about my Claude Code sessions. Are those sessions being pulled into the vault?

- **grep-first vs as-deployed**: as-deployed wins — Both answers give the same core narrative, but B provides more specific and useful detail about the pipeline steps and destination folder (AI Conversations/), while A adds tangential info about Cursor sessions and total wiki entries that wasn't asked about. B stays more focused on the actual question.
- **full-cov-hybrid vs grep-first**: grep-first wins — Both answers convey the same core information, but B provides more specific and useful detail (the date, the Cursor session count, the specific pipeline steps like classification and ingestion into raw/) while remaining equally accurate.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides more specific and useful details (session date, exact pipeline steps, enrichment job count, and destination folder in the vault), while Answer A includes a possibly conflated figure (1,780 wiki entries combined with Cursor) that is less directly tied to the Claude Code question.

## relationship-001

**Query:** Besides pvaughn, who else on the Directors Squad ended up owning one of the three restructured recurring meetings that came out of the offsite?

- **grep-first vs as-deployed**: as-deployed wins — Both answers identify the same owners (brownf and mewing), but B is slightly clearer by explicitly listing all three meetings before answering the question directly.
- **grep-first vs full-cov-hybrid**: tie — Both answers provide identical information—identifying brownf and mewing as the other owners with the same meeting details—with only trivial formatting differences.
- **full-cov-hybrid vs as-deployed**: tie — Both answers identify the same two owners (brownf and mewing) with the same meetings; they are substantively equivalent in accuracy and helpfulness.

## relationship-002

**Query:** Kevin Bement's group-management style was compared against two peer team leads during his calibration review - who were they, and what leadership trait were they both praised for that he was implicitly being measured against?

- **as-deployed vs grep-first**: grep-first wins — Both answers identify the same peers (Grig and Gagik) and trait (total ownership), but B is more helpful because it provides direct quotes from the source material to substantiate the claim.
- **grep-first vs full-cov-hybrid**: tie — Both answers identify the same peers (Grig and Gagik) and the same trait (taking ownership/total ownership), citing the same quote. They are substantively equivalent in accuracy and helpfulness.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Both answers identify the same peers (Grig and Gagik) and the same trait (taking ownership of the product). Answer B is slightly stronger because it includes a direct quote from the source, providing better evidentiary support.

## relationship-003

**Query:** Who evaluated Matt Newman during his calibration review, and what recurring criticism did that same evaluator flag about people who lean too far into future strategic thinking rather than execution?

- **as-deployed vs grep-first**: grep-first wins — Answer B provides specific, dated citations (May 2024, Nov 2024, May 2025) with direct quotes showing the recurring pattern, while Answer A is more general and vague. Both identify Bryan Pino as the evaluator, but B's specificity makes it more helpful and verifiable.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers identify Bryan Pino and cite similar calibration notes, but B provides more context with additional supporting details (Jeff's observation, impact across deliverables) and more clearly articulates the through-line criticism about the gap between strategy and execution.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides more specific detail with dated references (May 2024, May 2025, Nov 2024) and direct quotes, giving a fuller picture of the recurring criticism pattern, while Answer A is more generic and vague.

## relationship-004

**Query:** In the calibration review notes, which colleague was Arevik unfavorably compared to on the basis of team visibility, and what was that colleague specifically noted for by contrast?

- **grep-first vs as-deployed**: as-deployed wins — Both answers identify Chinna and acknowledge the lack of specific detail, but B is more precise in explicitly noting that no specific contrast behaviors are provided, while A slightly overstates by framing 'greater team visibility' as what Chinna was noted for, which is just restating the comparison.
- **full-cov-hybrid vs grep-first**: tie — Both answers identify Chinna as the colleague and note greater visibility as the basis of comparison, while acknowledging no further specifics are provided. Neither answer actually specifies what Chinna was noted for by contrast (beyond visibility itself), so they are essentially equivalent in content and accuracy.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Both answers identify Chinna as the colleague, but Answer A fabricates a specific quote and date (Nov 2024) not clearly supported, while Answer B honestly acknowledges the context lacks specifics about what Chinna was noted for.

## fuzzy-001

**Query:** that meeting where we went back and forth on how you'd even build trust in work that AI generated when the reviewers can't keep up with how much of it there is

- **as-deployed vs grep-first**: grep-first wins — Answer B identifies a specific meeting and provides concrete substantive details (slowdown paradox, Level 2/3 framing, Meter trial numbers, spec-based validation approach) that directly address the user's question, while Answer A largely disclaims that the context lacks the specific exchange without offering much substance. Without access to the ground truth, B appears more helpful and specific; if B were fabricating, A's hedging would be safer, but B's specificity and coherence suggest it is drawing from actual context.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B covers the same core content as A but adds two useful elements: the memorable framing quote 'Specification is the new source code' and the post-merge monitoring point that extends the trust mechanism. Both are otherwise accurate and similarly structured.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B identifies a specific meeting and provides substantive detail on the trust-building approaches discussed (spec verification, behavioral evaluation, AI-augmented PRs, monitoring), directly addressing the user's question. Answer A largely disclaims that the context doesn't contain the specifics, offering much less useful content.

## fuzzy-002

**Query:** the ask from a stakeholder who just wants the short version up front instead of having to dig through a big interactive document to find what actually matters

- **grep-first vs as-deployed**: as-deployed wins — The question appears to describe a stakeholder ask/request itself, and Answer B correctly identifies it as a documented request (attributing it to a specific stakeholder and noting its status), while Answer A misinterprets the question and fabricates an unrelated executive summary about Workfront and AI.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides a more complete executive summary, covering not just strategy and priorities but also what's shipping now and open questions being worked out, which better serves a stakeholder wanting the full short version. Answer A is tighter but omits useful context like the financial planning question and near-term vs. long-term tension.
- **as-deployed vs full-cov-hybrid**: as-deployed wins — The question is meta - it's asking about a stakeholder's request for TL;DR-style summaries, not asking for an actual summary of content. Answer A correctly identifies and describes the ask, while Answer B misinterprets the question and fabricates a summary of unrelated meeting content.

## fuzzy-003

**Query:** the realization that if your main account runs dry mid-session, the tool won't automatically switch you over to the backup way of paying for it - that has to be decided ahead of time

- **grep-first vs as-deployed**: as-deployed wins — Both answers convey the same conclusion that the context lacks the information, but B is more specific and informative by naming the actual topics covered in the context (MCP server configuration, Obsidian vault automation, etc.), giving the user a clearer picture of what was searched.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly addresses the question with specific, relevant details about Claude Code's provider selection behavior and workarounds, while Answer A claims no information is available.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly addresses the question with specific, relevant details about Claude Code's provider selection behavior and provides actionable workarounds, while Answer A simply claims insufficient context.

## fuzzy-004

**Query:** the call that each team gets to pick its own meeting cadence instead of being told when to meet, even though everyone's encouraged to get together often

- **grep-first vs as-deployed**: as-deployed wins — Answer B directly identifies the specific decision document, quotes the relevant policy, and provides its origin, while Answer A claims no such information exists in the context.
- **full-cov-hybrid vs grep-first**: tie — Both answers convey essentially the same information — that the context does not contain the requested policy — with nearly identical structure, accuracy, and level of detail.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B directly identifies the decision document matching the question's description, quotes the relevant text, and provides source context, while Answer A denies such information exists.

## fuzzy-005

**Query:** the request to double check a prior batch of review findings against good design principles before anyone trusts them

- **grep-first vs as-deployed**: grep-first wins — Answer A directly names the concept ("audit the audit") and explains it as a documented practice with a decision record, addressing both sessions referenced. Answer B only points to one session's turn and doesn't frame it as generally as the question asks.
- **grep-first vs full-cov-hybrid**: grep-first wins — Answer A directly names the practice ("audit the audit"), cites the decision document, and explains the concept as a reusable process, which better answers the question about what the request is called. Answer B focuses narrowly on one session example and doesn't clearly establish the term as the general name for the practice.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Both answers identify the same source and quote correctly, but B provides slightly more complete metadata (project, branch, date) and an additional concrete example of a misleading assertion, making it marginally more helpful.

## fuzzy-006

**Query:** the idea that got floated to build some kind of multi-axis chart so people doing those periodic people-reviews could see someone's strengths across several dimensions at a glance, instead of boiling everything down to one number

- **grep-first vs as-deployed**: as-deployed wins — Answer B provides more comprehensive detail including the timeline (November 2024), status (open/pending), both file locations, and notes a related but distinct RadarChart effort, giving a more thorough and useful response while covering everything A does.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers identify the same concept with similar accuracy, but B provides more complete detail including specific file paths, the framing of moving toward 'richer, data-informed calibration conversations,' and transparently notes that the source file isn't in the retrieved context.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B provides more specific and useful detail, including the November 2024 timeframe, the pending status of the decision, the two file locations where it's tracked, and a relevant cross-reference to a related RadarChart component, while covering all the same key points as A.

## fuzzy-007

**Query:** the commitment that leadership itself would put together and share an actual calendar of the recurring meetings, along with an explanation of what each one covers and why it exists, instead of leaving people to guess

- **grep-first vs as-deployed**: as-deployed wins — Answer B identifies a specific documented decision that directly matches the described commitment, while Answer A claims no such commitment exists in the context, making B more accurate and helpful.
- **full-cov-hybrid vs grep-first**: grep-first wins — Both answers correctly conclude the commitment isn't in the context, but B is more precise and helpful by directly citing the specific action items (Chelsie's email, Emily's scheduling) and clearly contrasting them with what the user asked about, whereas A includes some less relevant context about horizontal coordinators and dashboards.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B identifies a specific documented decision matching the question's description with a direct quote and source, while Answer A claims no such information exists in the context. Assuming B's citation is accurate, it directly answers the question.

## fuzzy-008

**Query:** the general review process used to rate senior technical people across several angles at once - the work they actually ship, how far their influence reaches, their leadership, how well they communicate, and how forward-looking their thinking is

- **as-deployed vs grep-first**: tie — Both answers correctly indicate that the provided context does not contain information about a senior technical review process; they are essentially equivalent in helpfulness and accuracy, with only minor differences in which context details they cite.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A directly addresses the question with a specific, structured mapping of the five review dimensions to the criteria described, while Answer B claims no relevant context exists.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B directly addresses the question by identifying the promotion packet review process and mapping the five evaluation criteria to the aspects in the question, while Answer A claims no relevant information exists.

## fuzzy-009

**Query:** the simplest workaround suggested: log in the normal way by default, and only manually flip yourself over to the backup option once you actually hit a limit, maybe going as far as setting up a one-word shortcut command so the switch takes less typing

- **grep-first vs as-deployed**: grep-first wins — Both answers reach the same conclusion that the context lacks the information, but Answer A provides more useful detail by noting the related April 11 meeting note about Claude session/token limits and adjacent workarounds, giving the user a partial anchor point.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides specific, actionable details matching the question (the alias command, the environment variable, and the source reference), while Answer A claims no such information exists in the context.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B provides specific, actionable details matching the question (manual switching, alias for one-word shortcut, contrast with LiteLLM), while Answer A claims no relevant context exists. Assuming B's cited context is accurate, it is far more helpful.

## fuzzy-010

**Query:** the observation that when people from different disciplines on a team actually lean into working closely together instead of staying in their own lane, that's when things go really well

- **as-deployed vs grep-first**: as-deployed wins — Answer A identifies a specific matching concept (Squad Collaboration) with a direct definition and concrete examples, while Answer B claims no such content exists in its context. Assuming both had access to relevant sources, A provides substantive, on-point information; even if contexts differed, A is more helpful to the user's question.
- **grep-first vs full-cov-hybrid**: full-cov-hybrid wins — Both answers correctly note the observation isn't explicitly in the context, but B provides more comprehensive and accurate sourcing by referencing both the 05-05 meeting notes and the Jamie Delbick 1x1 notes (with the Horizon architects cross-team collaboration example), while A only references the two engineering meetings and mischaracterizes the May 5th content as highlighting friction rather than a push toward cross-functional engagement.
- **full-cov-hybrid vs as-deployed**: full-cov-hybrid wins — Answer B appears to fabricate a specific wiki file, a direct quote, and details about a 'Directors Squad offsite' that cannot be verified, which is a hallucination risk. Answer A honestly acknowledges the observation isn't explicitly documented while surfacing the most relevant related content.

## fuzzy-011

**Query:** the new framework everyone was being aligned to that was expected to make figuring out what to prioritize noticeably harder

- **as-deployed vs grep-first**: as-deployed wins — Answer A directly identifies 'Strategic Levers and Outcomes' with a supporting quote from the notes, while Answer B speculates about a 'skills framework' and admits the specific phrasing isn't in the context, making it less confident and likely less accurate.
- **full-cov-hybrid vs grep-first**: grep-first wins — Answer B provides a plausible best-match candidate (the skills framework) with specific supporting details from the context about prioritization difficulties, while still honestly noting the exact phrasing isn't used. Answer A simply declines to answer, which is less helpful given B found relevant related content.
- **full-cov-hybrid vs as-deployed**: as-deployed wins — Answer B directly identifies the framework (Strategic Levers and Outcomes) with a supporting quote matching the question's description, while Answer A incorrectly claims the context lacks this information despite mentioning the same framework.

## fuzzy-012

**Query:** the recurring engineering ceremony where a team demos what it's actually shipped - whether a team even shows up to demo has become a talking point in how visible and accountable that team looks in review conversations

- **as-deployed vs grep-first**: grep-first wins — Answer B identifies the ceremony (sprint review) with supporting evidence from the context, while still honestly noting the specific claim about attendance as accountability signal is unsupported. Answer A only names 'Structured Demos' without providing corroborating detail and is less informative overall.
- **full-cov-hybrid vs grep-first**: full-cov-hybrid wins — Answer A identifies a specific ceremony (Execution Meeting) with concrete details from the context and finds a directly relevant quote about optics/attendance from Chelsie, partially supporting the accountability angle. Answer B identifies a more generic 'sprint review' and finds less relevant supporting evidence.
- **as-deployed vs full-cov-hybrid**: full-cov-hybrid wins — Answer B identifies the specific ceremony (Execution Meeting) with concrete details from the context and honestly notes related but not identical support for the accountability angle, while Answer A only vaguely names 'Structured Demos' and provides less useful information.

## Aggregate tally

| Variant | Wins | Losses | Ties |
|---|---|---|---|
| grep-first | 55 | 80 | 19 |
| as-deployed | 81 | 59 | 14 |
| full-cov-hybrid | 69 | 66 | 19 |