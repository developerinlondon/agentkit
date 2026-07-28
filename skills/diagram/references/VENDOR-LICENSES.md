# Vendor icon pack licences

Cloud-vendor icon sets are **not** CC0. They are licensed by the vendor — usually
to represent that vendor's own services, and usually with no permission to
redistribute. This repository therefore carries **no vendor artwork**: only the
upstream URL, a sha256 pin, and the terms below.

Packs are fetched on demand, from the vendor's own endpoint, onto the machine
that will use them:

```bash
bun skills/diagram/scripts/fetch-icons.ts <pack> --accept-terms
```

The fetch is opt-in and never runs from `install.sh`. Accepting the terms is a
decision the installing user makes, so the script prints them and refuses to
download until `--accept-terms` is passed. Each fetched tree carries a `NOTICE`
reproducing its terms, plus any terms file shipped inside the archive itself.

The quoted terms below are the machine-readable copies in
`skills/diagram/assets/vendor-packs.json`; a test fails if the two drift apart.
They are quoted for identification and are **not** a substitute for reading the
vendor's own page, which can change without notice.

## `azure` — Microsoft Azure architecture icons

- **Vendor**: Microsoft
- **Licence**: Microsoft Azure icon terms of use (proprietary; no SPDX identifier)
- **Permission to use**: expressly granted
- **Source**: <https://learn.microsoft.com/en-us/azure/architecture/icons/>
- **Terms**: <https://learn.microsoft.com/en-us/azure/architecture/icons/>

Archives, pinned by sha256:

- `https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V24.zip`\
  `sha256:921594ccd1bf3d9c0a1bd7b6d924e050551a59342f2b353bb74bdcf761c35141`

Terms, verbatim:

> Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation. You may copy, distribute, and display the icons only for the permitted use unless granted explicit permission by Microsoft. Microsoft reserves all other rights.

> Don't crop, flip, or rotate icons.

> Don't distort or change icon shape in any way.

> Don't use Microsoft product icons to represent your product or service.

> Icons may not be cropped, flipped or rotated, and their shape may not be distorted or changed. (Azure_Icons_FAQ.pdf)

## `gcp` — Google Cloud product and category icons

- **Vendor**: Google
- **Licence**: No licence granted — Google publishes this set with no terms of use
- **Permission to use**: **no licence granted**
- **Source**: <https://cloud.google.com/icons>
- **Terms**: <https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/trademark-guidelines-for-proper-usage/>

Archives, pinned by sha256:

- `https://services.google.com/fh/files/misc/core-products-icons.zip`\
  `sha256:6531a10f58bc599c24d9a455d81dd757c1a03c3c43da9cddf639b859c1c1eece`
- `https://services.google.com/fh/files/misc/category-icons.zip`\
  `sha256:e5bc3abd3527dc2500e9bff7f15870783e2c764129c49b7cd4c1b4e105345002`
- `https://services.google.com/fh/files/misc/google-cloud-legacy-icons.zip`\
  `sha256:a6d9d7921758042538b462f03cf64614c2cebd96743b3ed63580a769fc7de3e9`

Terms, verbatim:

> Google states no licence, terms of use, permission or attribution requirement for this icon set. The library page reads in full: "Welcome to the official library for Google Cloud product icons. Here you can find the Google Cloud product icons you need for your diagrams, technical documentation, and more." No archive contains a LICENSE or README, and every page of the accompanying overview PDF is stamped "Google Cloud Proprietary & Confidential".

> The nearest governing text is Google's trademark guidance: "Don't remove, distort, or alter any element of a Google Brand Feature. You may not modify Google Brand Features by hyphenation or combination, or by shortening, abbreviating, or creating acronyms."

> "Use only Google-approved artwork when using Google's logos."

> Because no permission is granted, this pack is fetched from Google's own endpoint onto your machine and is never redistributed. Satisfy yourself that your use is permitted before relying on it.

## Why AWS is not a fetch-on-install pack

AWS publishes an architecture icon package at <https://aws.amazon.com/architecture/icons/>,
and its terms are permissive enough ("We allow customers and partners to use
these toolkits and assets to create architecture diagrams"). It is excluded for
a mechanical reason: the download URL embeds a release date **and a content
hash** —
`.../architecture-icons/Icon-package_04302026.4705b90f…ee1.zip` — the hash cannot
be derived, and previous quarters' URLs return `403` once superseded. A pinned
URL would therefore break every quarter, and the alternative (scraping the
landing page at fetch time for whatever URL it currently advertises) defeats the
pin: it would download whatever AWS is serving, unverified.

The bundled CC0 `logos` set already covers the common AWS marks
(`@logos:aws-lambda`, `@logos:aws-s3`, `@logos:aws-ecs`, and ~20 more), so the
gap is small. Revisit if AWS publishes a stable, versioned URL.
