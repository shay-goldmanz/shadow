# Vision
Shadow helps the operator to distill his beliefs and experience into curated volumes, indexed and accessbile to agents to capture the operator's "way" of doing things

# Critical path
- Operator opens interface and creates a volume
- A session is started with Shadow, volume is named and currently empty
- Operator gives Shadow some context and tells him he believes in how Linear and Notion designs UI, and that Epoch magazine are experts in designing one-pagers
- Shadow invokes tools and skills to extrapolate how Linear and Notion design UI and how Epoch magazine design one-pagers
- Shadow add 2 chapters to the newly created volume
- Volume is indexed and accessible by CLI
- time passes ...
- Operator opens his agent, asking him to design a one pager
- Agent invokes the CLI without being explicitly asked to, reasons over the volumes and finds the right chapter

# Acceptance Criteria
- Repo contains CLI, chat agent "Shadow" (the shadow writer) and interface, volumes indexing mechanism and api
- PageIndex-like-or-better strategy is used to index a volume when it is created/edited
- Shadow agent is the user-facing chat agent
- The heavy-lifting of fetching data for volumes is offloaded from Shadow, defered to tools or tool-agents
- CLI is used by agents during sessions to find the right volume for the task, if it exists
- CLI is used in agentic reasoning over the volume
- Writing volumes is done and guided via skills
- The entire stack runs on the operator's AI subscriptions, NOT on api keys
