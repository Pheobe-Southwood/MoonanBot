# SQLite is the only source of truth

MoonanBot stores both character state and operational history in one transactional SQLite database. Human-friendly forms and versioned exports replace editable mirror files, avoiding ambiguous two-way synchronization while preserving portability.
