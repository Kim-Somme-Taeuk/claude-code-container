# Device Lab input clarity

Eleven tools now omit a redundant single-choice backend selector from discovery.
Calls supply the supported backend automatically, while existing explicit calls
remain compatible. Contradictory selectors fail before provider execution,
including the previous QEMU fallback on an owned ID. Creation exposes named
fields instead of a generic options wrapper; runtime compatibility remains.
Platform guidance distinguishes Android/iOS app IDs, permission inputs, mobile
keys and battery status values. These changes do not remove owner, lock or policy
checks and do not route container-QEMU tools to host Hyper-V guests.
