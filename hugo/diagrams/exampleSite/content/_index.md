---
title: Diagrams example
---

A request flows from the browser to a stateless API, which writes to Postgres and hands slow
work to a queue.

{{< diagram "checkout" >}}

The same exchange as messages, with the approval branch:

{{< diagram "refund" >}}
