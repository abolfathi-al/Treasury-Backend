# RTK

Use RTK for supported high-volume, human-readable commands:

- `rtk git status|diff|log`
- `rtk grep|find|read`
- `rtk test|lint|tsc|npm|pnpm` during iterative checks

Accuracy guards:

- Run the final test/release gate raw (or through `rtk proxy`) so warnings and
  summaries remain complete.
- Use raw commands or `rtk proxy` for Graphify generation, machine-readable
  JSON, exact hashes, and any output RTK reports as truncated.
- Rerun raw when an RTK summary is ambiguous.
