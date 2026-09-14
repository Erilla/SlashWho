# Pin pg-boss while queue startup depends on its private schema

SlashWho pins pg-boss to version 12.27.0 because queue startup directly migrates pg-boss's private `queue` and `job` tables to the `exclusive` policy and relies on the ordering of its private `job_state` enum. The migration is retained so previously deployed queues are upgraded without losing their FIFO head, and any pg-boss version change must be deliberate and must pass the queue-policy migration integration test against the proposed version before the pin is updated.
