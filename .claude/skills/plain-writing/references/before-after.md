# Worked rewrites

## Structure: buried point → main point above, context below

Before (Slack message to a manager, 96 words, ask buried at the end):
> Hey! So last sprint we picked up the billing migration and I spent Monday and Tuesday going through the old Stripe webhooks, which turned out to be more tangled than we thought because there are three handlers that all write to the same table. I also looked at how the finance team reconciles this today, and talked to Priya about it on Wednesday. Anyway there's a risk we double-charge people during the cutover if we don't freeze writes, so I was thinking maybe we should decide something about that this week?

After (54 words):
> **I need a decision by Thursday: can we freeze billing writes for the 30-minute cutover window?**
>
> Without a freeze, we risk double-charging customers during the migration.
>
> For context: three legacy Stripe webhook handlers all write to the same table, so a partial cutover is not safe. Priya confirmed finance can reconcile after a freeze.
>
> As a next step, reply with yes or no and I'll schedule the window.

What changed:
- Main point above, context below. The ask moved from the last clause to the first line.
- Minimum viable backstory. The Monday/Tuesday/Wednesday play-by-play is gone; only the fact that makes the decision necessary survives.
- The vague *decide something about that this week* became a named decision with a named deadline.
- Signposts added: *For context*, *As a next step*.
- Hedging removed: *I was thinking maybe we should* → a direct ask.

## Tone: the robot voice pass

| Before (reads cold when flat) | After |
| --- | --- |
| Please review and share your feedback. | Could you review and share feedback? |
| Sending this again. | Following up in case this got buried — no rush. |
| That's not what I asked for. | I think we're solving different problems — I was after X. Can we sync? |

## Passive → active

| Original | Rewrite |
| --- | --- |
| The delivery van was driven by Kumar, but the log book wasn't updated with the mileage. | Kumar drove the delivery van but did not record the mileage in the log book. |
| The narrative written by our team wasn't included in the final proposal. | The final proposal omitted the narrative our team wrote. |
| The SOP was written by who? | Who wrote the SOP? |
| To be included in the proposal will be a list of issues, their solutions, and strategies for implementation. | The proposal will list the issues, their solutions, and the implementation strategies. |
| The updated coding samples were sent to several reviewers last Tuesday, but the document wasn't received. | We sent the updated coding samples to several reviewers last Tuesday, but the reviewers did not receive the document. |

## Passage rewrite: passive → active

Before (passive, hard to answer questions from):
> Providing a clean, safe, and healthy work environment for all employees, contractors, and visitors is a commitment by the company. All applicable health and safety legislation and regulations must be followed by employees at all times. Employees are encouraged to contact the Health and Safety Team with any questions. In addition, maintaining health and safety standards in excess of the stated minimum legal requirements for the work place is the objective of the company. The responsibility for health and safety is borne by all employees…

After (active, same facts, fewer words):
> Our objective is to maintain health and safety standards above the minimum legal requirements. To that end, we provide a clean, safe, and healthy work environment for all employees, contractors, and visitors. We also provide health and safety training. All employees must follow health and safety legislation, regulations, safety rules, policies, and procedures at all times. Work safely, do not create hazards for others, and report all hazards, accidents, injuries, and unsafe conditions. If you have questions, contact the Health and Safety Team.

The test: time how long it takes a reader to answer *who must report hazards?* from each version.

## Weak verbs → strong verbs

| Original | Rewrite |
| --- | --- |
| Be sure to check that you have de-energized the system before you do any work in order to be preventative of electric shock. | To prevent electric shock, de-energize the system before you work on it. |
| The purpose of the warehouse is to store all available server parts from vendors. | The warehouse stores all server parts from vendors. |
| We are in the investigative stage for determining why the code doesn't work. | We are investigating why the code fails. |
| There are several reasons why we would recommend writing new SOPs for the procedure. | We recommend new SOPs for the procedure for several reasons. |
| We asked the vendor to correct the problem immediately. | We asked the vendor to correct the problem by 5 p.m. today. |
| Julietta was very enthusiastic about her finding of the resolution of the system problem. | Julietta was glad she resolved the system problem. |

Note the *immediately* fix: deleting a vague adverb forces you to state the real deadline.

## Fluff removal

| Original | Rewrite |
| --- | --- |
| I am writing you this email because I want to ask you if you could work my shift for me on Tuesday, July 18. | Could you work my shift on Tuesday, July 18? |
| It has come to our attention that we need to address several safety issues in the data center. | We must address several safety issues in the data center. |
| Each technician performing work under the MCM is required to be properly trained and authorized for the task at hand. Qualifications need to be assessed in advance of scheduling the work in order to avoid production delays due to lack of training. | Each technician working under the MCM must be trained and authorized for the task. Assess qualifications before scheduling the work to avoid delays. |
| Our end goal is to take the bull by the horns and solve the problem once and for all by thinking outside the box. | Our goal is to solve the problem permanently with an original approach. |

## Long sentences → short sentences

| Original | Rewrite |
| --- | --- |
| After all of the information has been filled out and the proper quote is attached, your manager must be asked to approve the purchase but not if the purchase is on a CAR because then a manager's approval is not needed because the items will be listed on the CAR. | Complete the information and attach the quote. Then ask your manager to approve the purchase. Purchases already listed on a CAR do not need manager approval. |
| CodeBrowser is a web UI for viewing source code and other code metadata and you can use it for managing code permissions. It will eventually be possible to do code reviews here, and to search code. | CodeBrowser is a web UI for viewing source code and metadata. You can also use it to manage code permissions. Code review and code search are coming. |
| The completed document will be signed by both the project engineer responsible for the build and the future facility manager. It is incumbent upon the project engineer and facility manager to validate the work and sign the document. | The project engineer and the future facility manager must validate the work and sign the completed document within six weeks of handoff. |

## Paragraph rewrite

Before:
> Writing high quality code is extremely important and it's important to establish coding standards. Coding standards that are available within the company and in the industry often contradict each other on what rules are a must to generate good code. In addition, software developers also have strong individual preferences on the rules that contribute toward good code. Coding standards need to be customized and one size does not fit everyone.

After:
> High quality code requires coding standards. Existing standards, both internal and industry-wide, often contradict each other, and developers hold strong preferences of their own. So we customize our standards rather than adopt one set for everyone.

61 words → 40 words, same meaning, one idea per sentence.
