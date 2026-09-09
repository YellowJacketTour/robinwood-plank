# Mesh query deadlines

Production diagnostics on 2026-09-09 reported repeated Query read timeout errors
in Seaport activity and UniSat membership/rarity work. The shared PostgreSQL pool
allowed mesh SQL to run for 120 seconds but abandoned its response after 20 seconds.
The driver's client timeout reports an error without cancelling the active SQL.

Mesh queries now use an 80-second server cancellation deadline and an 85-second
client response deadline, both below the scheduler's 89-second child termination.
Web requests retain their existing 15/20-second pair. This removes the contradictory
cutoff; it does not claim every slow query or provider failure is solved.

An actual PostgreSQL test completes a 21-second query through the shared mesh pool,
verifies server cancellation returns SQLSTATE 57014 and leaves the connection
usable, and confirms the web deadlines remain unchanged.
