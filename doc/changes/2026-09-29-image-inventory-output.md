# Image and inventory output

Default Linux VM image list/import results no longer repeat ownership metadata
and generated image timestamps. Image identity and artifact paths remain usable.
Inventory omits generated provider execution plans using the same presentation
as device list/status. Detailed responses, failures and unknown data retain
their diagnostic content.

A fresh 93-tool audit identified further request, flow and provider-response
work under the active full-UX goal; this change does not claim complete coverage.
