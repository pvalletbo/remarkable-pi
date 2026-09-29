# Stock web API notes

The stock reMarkable USB interface is intended for browser file transfer. Its API is not a public supported SDK. These routes were checked against independent existing clients; physical firmware validation is still required.

## Listing

```http
POST http://10.11.99.1/documents/
Content-Length: 0
```

A folder uses `/documents/<folder-id>`. Expected JSON shape:

```json
[
  { "ID": "a-document-uuid", "VissibleName": "Agent notes", "Type": "DocumentType" },
  { "ID": "a-folder-uuid", "VissibleName": "Work", "Type": "CollectionType" }
]
```

`VissibleName` really is misspelled in the stock protocol. This project also accepts `VisibleName`. Revision fields such as `Version`/`LastModified` may be absent, so they are not relied on exclusively.

The POST is an empty read-only directory query, **not** an upload. The client walks folders with cycle detection and count limits, then a watcher queries only its selected notebook's parent folder. The special trash folder is not traversed.

## Export

```http
GET http://10.11.99.1/download/<document-id>/placeholder
```

`placeholder` is a literal route component used by stock clients. The server can set Content-Disposition, but this project ignores the filename: IDs and hashes address the local cache. Notebook names never determine writable paths. Non-PDF responses, HTTP errors, redirects and oversized/chunked responses are rejected.

Exports reflect whatever the tablet has saved. The bridge cannot force an open notebook to flush recent pen strokes.

## Wireless forwarding

The stock server normally lives at the USB-interface address, not the Wi-Fi address. Forwarding through existing SSH over Wi-Fi can reach `10.11.99.1:80` **on the tablet** when the interface is still available. Some firmware removes that address after USB disconnect, which defeats a read-only tunnel. This project does not compensate by modifying startup scripts, assigning addresses, or patching xochitl.

## Sources consulted

- Official [USB file transfer help](https://support.remarkable.com/s/article/Transferring-files-using-a-USB-cable).
- [aeblyve/rmweb](https://github.com/aeblyve/rmweb/blob/main/rmweb): empty POST listing and GET PDF download route.
- [Eeems-Org/remarkable-usb-web-interface-fuse](https://github.com/Eeems-Org/remarkable-usb-web-interface-fuse/blob/main/remarkable_usb_web_interface_fuse/fuse.py): corroborating route/field behavior. This project does not use FUSE or its write operations.
- [reHackable/scripts repull](https://github.com/reHackable/scripts/blob/master/host/repull.sh): PDF download route.
- [webinterface-persist-ip notes](https://github.com/rM-self-serve/webinterface-persist-ip): why USB disconnection can remove the internal address. Its installation/modification approach is **not** used here.
- Pi's installed [extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): lifecycle, custom messages and follow-up delivery. Development was checked against pi `0.99.1`.

Protocol facts informed an independent implementation; none of these clients is vendored or run on the tablet.
