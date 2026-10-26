# L2 · Data & AI

Drill-down of **Data & AI platform** from the [L1 landscape](README.md). Operational data and events
land in BigQuery, dbt models them, Looker serves analysts, and Vertex AI serves models back to the
products.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#F4F2FF"
    primaryBorderColor: "#7C5CDB"
    primaryTextColor: "#2A1B5C"
    lineColor: "#9C8FCB"
    clusterBkg: "#FAF9FF"
    clusterBorder: "#D6CCF5"
    edgeLabelBackground: "#FFFFFF"
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
---
flowchart LR
    subgraph sources [Sources]
        direction TB
        oltp@{ icon: "logos:postgresql", label: "Orders DB · CDC", pos: "b", h: 40 }
        stream@{ icon: "logos:google-cloud", label: "Pub/Sub events", pos: "b", h: 40 }
        saas@{ icon: "logos:google-icon", label: "SaaS exports", pos: "b", h: 40 }
    end
    subgraph ingest [Ingest & orchestrate]
        direction TB
        airflow@{ icon: "logos:airflow-icon", label: "Cloud Composer · Airflow", pos: "b", h: 40 }
        spark@{ icon: "logos:apache-spark", label: "Dataproc · Spark", pos: "b", h: 40 }
    end
    subgraph warehouse [Warehouse]
        direction TB
        bq@{ icon: "logos:google-cloud", label: "BigQuery", pos: "b", h: 48 }
        dbt@{ icon: "logos:dbt-icon", label: "dbt models", pos: "b", h: 40 }
    end
    subgraph consume [Consume]
        direction TB
        looker@{ icon: "logos:looker-icon", label: "Looker · BI", pos: "b", h: 40 }
        notebooks@{ icon: "logos:jupyter", label: "Notebooks", pos: "b", h: 40 }
        vertex@{ icon: "logos:google-gemini-icon", label: "Vertex AI · Gemini", pos: "b", h: 40 }
        training@{ icon: "logos:pytorch-icon", label: "Model training · PyTorch", pos: "b", h: 40 }
    end
    products([Digital products])
    oltp -->|Datastream| bq
    stream -->|subscriptions| bq
    saas --> airflow
    airflow --> bq
    airflow --> spark
    spark --> bq
    dbt -->|transform| bq
    bq --> looker
    bq --> notebooks
    bq --> training
    training --> vertex
    vertex -->|recommendations API| products
    style sources fill:#F8FAFC,stroke:#CBD5E1
    click products href "./l2-digital-products.md"
```
