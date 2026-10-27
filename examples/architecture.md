# Shop Platform Architecture

This file is the source of truth for the platform's architecture. Edit it with
`mermdraw examples/architecture.md` (visual) or any text editor — both stay in sync.

## System overview

```mermaid
flowchart LR
    user([Customer])
    admin([Ops engineer])
    cdn{{CDN}}
    subgraph edge [Edge]
        gateway[API Gateway]
        auth[Auth Service]
    end
    subgraph core [Core services]
        orders[Orders]
        catalog[Catalog]
        payments[[Payments]]
    end
    subgraph data [Data]
        pg[(Postgres)]
        cache[(Redis)]
        bus@{ shape: h-cyl, label: "Event bus" }
    end
    note@{ shape: text, label: "All services run on k8s" }
    user -->|HTTPS| cdn
    cdn --> gateway
    admin -.->|VPN| gateway
    gateway --> auth
    gateway --> orders
    gateway --> catalog
    orders --> payments
    orders --> pg
    catalog --> cache
    orders -.->|OrderPlaced| bus
    payments -.->|PaymentSettled| bus
    click payments href "./payments.md" "Payments deep dive"
    style payments fill:#fde7c8,stroke:#c98a12
```

## Checkout flow

```mermaid
sequenceDiagram
    participant U as Customer
    participant G as Gateway
    participant O as Orders
    participant P as Payments
    U->>G: POST /checkout
    G->>O: create order
    O->>P: authorize card
    P-->>O: authorized
    O-->>U: 201 Created
```

## Deployment

```mermaid
architecture-beta
    group cloud(cloud)[AWS]

    service lb(internet)[Load balancer] in cloud
    service app(server)[App] in cloud
    service db(database)[RDS] in cloud

    lb:R --> L:app
    app:R --> L:db
```
