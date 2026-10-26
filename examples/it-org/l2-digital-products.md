# L2 · Digital products

Drill-down of **Commerce platform** from the [L1 landscape](README.md). Product logos come from the
`logos` icon pack (`mmdr icons add logos`); without it, mermaid shows placeholder icons but keeps
the labels and structure.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#4F6BED"
    primaryTextColor: "#1E2457"
    lineColor: "#8A93BF"
    clusterBkg: "#F7F8FD"
    clusterBorder: "#C3CBF3"
    edgeLabelBackground: "#FFFFFF"
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
---
flowchart LR
    shopper([Shopper])
    stripe@{ icon: "logos:stripe", label: "Payments · Stripe", pos: "b", h: 36 }
    subgraph edge [Edge]
        direction TB
        cdn@{ icon: "logos:cloudflare-icon", label: "Cloudflare CDN + WAF", pos: "b", h: 44 }
        ingress@{ icon: "logos:nginx", label: "nginx ingress", pos: "b", h: 44 }
    end
    subgraph experience [Experience]
        direction TB
        web@{ icon: "logos:nextjs-icon", label: "Storefront · Next.js", pos: "b", h: 44 }
        app@{ icon: "logos:react", label: "Mobile app · React Native", pos: "b", h: 44 }
        bff@{ icon: "logos:typescript-icon", label: "BFF · GraphQL", pos: "b", h: 44 }
    end
    subgraph services [Services · GKE]
        direction TB
        catalog@{ icon: "logos:fastapi-icon", label: "Catalog API · FastAPI", pos: "b", h: 44 }
        cart@{ icon: "logos:python", label: "Cart API · Python", pos: "b", h: 44 }
        pricing@{ icon: "logos:rust", label: "Pricing engine · Rust", pos: "b", h: 44 }
        checkout@{ icon: "logos:go", label: "Checkout · Go", pos: "b", h: 44 }
        search@{ icon: "logos:elasticsearch", label: "Search", pos: "b", h: 44 }
    end
    subgraph state [State]
        direction TB
        orders@{ icon: "logos:postgresql", label: "Orders DB · Cloud SQL", pos: "b", h: 44 }
        sessions@{ icon: "logos:redis", label: "Sessions · Memorystore", pos: "b", h: 44 }
        events@{ icon: "logos:google-cloud", label: "Order events · Pub/Sub", pos: "b", h: 44 }
    end
    shopper -->|HTTPS| cdn
    cdn --> ingress
    ingress --> web
    ingress --> bff
    app -->|GraphQL| bff
    web --> bff
    bff -->|gRPC| catalog
    bff -->|gRPC| cart
    bff -->|gRPC| checkout
    catalog --> search
    cart --> pricing
    cart --> sessions
    checkout --> pricing
    checkout --> orders
    checkout -->|tokenized card| stripe
    checkout -.->|OrderPlaced| events
    style edge fill:#FFF9F2,stroke:#F2C9A5
    style state fill:#F2FBF6,stroke:#9FD8B9
    click events href "./l2-data-ai.md" "Consumed by the data platform"
    %% mmdr:layout shopper:0,0 stripe:1100,260 cdn:180,0 ingress:350,0 web:540,-110 app:540,110 bff:720,0 catalog:910,-140 cart:910,0 pricing:1100,70 checkout:910,140 search:1100,-140 orders:1290,140 sessions:1290,0 events:1290,-140
```
